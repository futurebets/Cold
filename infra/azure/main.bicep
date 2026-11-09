// Cold on Azure: one Container App (API + web + jobs) and a Burstable PostgreSQL Flexible Server.
// Sized for cost: a single 0.5 vCPU / 1 GiB replica and a B1ms database.
//
//   az group create -n cold-rg -l eastus
//   az deployment group create -g cold-rg -f infra/azure/main.bicep \
//     -p image=ghcr.io/<owner>/cold:latest appSecret=<32+ random chars> dbAdminPassword=<strong password> \
//        registryServer=ghcr.io registryUsername=<github user> registryPassword=<PAT with read:packages>

@description('Short name used as a prefix for every resource.')
param name string = 'cold'

@description('Azure region.')
param location string = resourceGroup().location

@description('Container image to run, e.g. ghcr.io/acme/cold:latest')
param image string

@description('Encryption key for stored credentials and session signing (32+ characters). Keep it safe: losing it makes saved integration secrets unreadable.')
@secure()
@minLength(32)
param appSecret string

@description('PostgreSQL administrator login.')
param dbAdminLogin string = 'coldadmin'

@description('PostgreSQL administrator password.')
@secure()
param dbAdminPassword string

@description('Container registry server (leave empty for a public image).')
param registryServer string = ''
param registryUsername string = ''
@secure()
param registryPassword string = ''

@description('vCPU for the app container (0.25, 0.5, 0.75, 1...).')
param cpu string = '0.5'

@description('Memory for the app container (must pair with cpu: 0.25→0.5Gi, 0.5→1Gi, 1→2Gi).')
param memory string = '1Gi'

var suffix = uniqueString(resourceGroup().id)
var dbServerName = '${name}-pg-${suffix}'
var useRegistry = !empty(registryServer)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: dbServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: dbAdminLogin
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: pg
  name: 'cold'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Allows connections from Azure services (the Container App). The server still requires
// TLS and the admin password. For stricter isolation, move both into a VNet.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

var databaseUrl = 'postgres://${dbAdminLogin}:${uriComponent(dbAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/cold?sslmode=require'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      secrets: concat(
        [
          { name: 'database-url', value: databaseUrl }
          { name: 'app-secret', value: appSecret }
        ],
        useRegistry ? [{ name: 'registry-password', value: registryPassword }] : []
      )
      registries: useRegistry ? [{ server: registryServer, username: registryUsername, passwordSecretRef: 'registry-password' }] : []
    }
    template: {
      containers: [
        {
          name: 'cold'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'APP_SECRET', secretRef: 'app-secret' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 20, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 }
          ]
        }
      ]
      // Exactly one replica: the in-process scheduler must run once (and it keeps the sender running 24/7).
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [db, pgAllowAzure]
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output postgresHost string = pg.properties.fullyQualifiedDomainName
