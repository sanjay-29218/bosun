import { createFileRoute } from "@tanstack/react-router";
import { useCallback, type ComponentProps } from "react";

import { FeaturesPage, type FeaturesSearch } from "../components/features/FeaturesPage";

export const Route = createFileRoute("/_chat/features")({
  validateSearch: (raw: Record<string, unknown>): FeaturesSearch => ({
    ...(raw.needsYou === true || raw.needsYou === "1" || raw.needsYou === 1
      ? { needsYou: true }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q } : {}),
    ...(typeof raw.project === "string" && raw.project ? { project: raw.project } : {}),
  }),
  component: FeaturesRouteView,
});

function FeaturesRouteView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearchChange = useCallback<ComponentProps<typeof FeaturesPage>["onSearchChange"]>(
    (patch) =>
      void navigate({
        search: (previous) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next as FeaturesSearch;
        },
        replace: true,
      }),
    [navigate],
  );
  return <FeaturesPage search={search} onSearchChange={onSearchChange} />;
}
