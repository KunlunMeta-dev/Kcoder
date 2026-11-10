import { vi } from "vitest";

// Node tests have no Expo host. Version fixtures can override this per suite.
vi.mock("expo-constants", () => ({ default: {} }));
