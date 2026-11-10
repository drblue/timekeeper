import { defineConfig } from "prisma/config";

export default defineConfig({
	datasource: { url: process.env.TIMEKEEPER_FIXTURE_DATABASE_URL },
});
