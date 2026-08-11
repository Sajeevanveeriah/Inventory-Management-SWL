import { createFixtureProvider } from "../../server/search/fixtureProvider.mjs";

globalThis.__SWL_TEST_ONLY_SEARCH_PROVIDER_FACTORY__ = createFixtureProvider;
await import("../../server/index.mjs");
