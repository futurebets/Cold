import { Route, Routes } from "react-router";
import { useGet } from "./lib/api";
import { Layout } from "./components/layout";
import { Loading } from "./components/ui";
import { LoginPage, SetupPage } from "./pages/Auth";
import OverviewPage from "./pages/Overview";
import DomainsPage from "./pages/Domains";
import DomainDetailPage from "./pages/DomainDetail";
import ReservePage from "./pages/Reserve";
import PlannerPage from "./pages/Planner";
import ListsPage from "./pages/Lists";
import ListDetailPage from "./pages/ListDetail";
import CampaignsPage from "./pages/Campaigns";
import CampaignEditorPage from "./pages/CampaignEditor";
import InboxPage from "./pages/Inbox";
import HealthPage from "./pages/Health";
import { DiagnosesPage, DiagnosisDetailPage } from "./pages/Diagnoses";
import { RotationsPage, RotationDetailPage } from "./pages/Rotations";
import ActivityPage from "./pages/Activity";
import SettingsPage from "./pages/Settings";

export function App() {
  const state = useGet<{ needsSetup: boolean; setupTokenRequired?: boolean; demo?: boolean; user: { id: string; name: string; email: string; role: string } | null }>("/auth/state", { staleTime: 60_000 });
  if (state.isLoading) return <Loading label="Starting Cold…" />;
  if (state.data?.needsSetup) return <SetupPage tokenRequired={!!state.data.setupTokenRequired} />;
  if (!state.data?.user) return <LoginPage demo={state.data?.demo} />;
  return (
    <Routes>
      <Route element={<Layout user={state.data.user} />}>
        <Route index element={<OverviewPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="domains/:id" element={<DomainDetailPage />} />
        <Route path="reserve" element={<ReservePage />} />
        <Route path="planner" element={<PlannerPage />} />
        <Route path="lists" element={<ListsPage />} />
        <Route path="lists/:id" element={<ListDetailPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="campaigns/:id" element={<CampaignEditorPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="inbox/:id" element={<InboxPage />} />
        <Route path="health" element={<HealthPage />} />
        <Route path="diagnoses" element={<DiagnosesPage />} />
        <Route path="diagnoses/:id" element={<DiagnosisDetailPage />} />
        <Route path="rotations" element={<RotationsPage />} />
        <Route path="rotations/:id" element={<RotationDetailPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:tab" element={<SettingsPage />} />
        <Route path="*" element={<OverviewPage />} />
      </Route>
    </Routes>
  );
}
