const storageEntries = new Map<string, string>();

function installStorageMock(target: Record<string, unknown>) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageEntries.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageEntries.delete(key);
      },
      clear: () => {
        storageEntries.clear();
      },
    },
  });
}

if (
  typeof globalThis.localStorage?.getItem !== "function"
  || typeof globalThis.localStorage?.setItem !== "function"
  || typeof globalThis.localStorage?.removeItem !== "function"
  || typeof globalThis.localStorage?.clear !== "function"
) {
  installStorageMock(globalThis);
}

if (typeof window !== "undefined" && window.localStorage !== globalThis.localStorage) {
  installStorageMock(window as unknown as Record<string, unknown>);
}

// The localStorage mock above is shared across all test files in a worker, so a
// locale-switching test could leave i18n in another language and flip every
// translated component for later tests. Pin the UI locale to English before each
// test — the suite asserts English copy (the defaultValue of each t(...) call).
import { beforeEach } from "vitest";
import { i18n } from "./src/i18n";

beforeEach(async () => {
  storageEntries.delete("workcell.ui-locale");
  if (i18n.language !== "en") {
    await i18n.changeLanguage("en");
  }
});
