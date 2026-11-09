/** `npm run demo`: start Cold with a seeded, simulated demo workspace. */
process.env.DEMO = "true";
process.env.DATA_DIR ??= "./data/demo";
process.env.SIM_DELAY_MINUTES ??= "2";
await import("../index");
export {};
