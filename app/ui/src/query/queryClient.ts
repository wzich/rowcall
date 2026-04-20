import { QueryClient } from "@tanstack/react-query";

// Keep one QueryClient for the whole UI. Creating it outside React prevents a
// fresh cache from being created on every render and gives future graph loads,
// validations, saves, and runs a shared server-state cache.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The local runtime is expected to be nearby and fast. A single retry
      // smooths over brief dev-server startup races without hiding persistent
      // API or validation problems for long.
      retry: 1,
    },
  },
});
