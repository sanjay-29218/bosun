import { createFileRoute } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { FeaturesPage, type FeaturesSearch } from "../components/features/FeaturesPage";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: (raw: Record<string, unknown>): FeaturesSearch => ({
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q } : {}),
    ...(typeof raw.project === "string" && raw.project ? { project: raw.project } : {}),
    ...(typeof raw.milestone === "string" && raw.milestone ? { milestone: raw.milestone } : {}),
  }),
  component: BoardRouteView,
});

function BoardRouteView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onSearchChange: ComponentProps<typeof FeaturesPage>["onSearchChange"] = (patch) =>
    void navigate({
      search: (previous) => {
        const next: Record<string, unknown> = { ...previous, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next as FeaturesSearch;
      },
      replace: true,
    });
  return <FeaturesPage search={search} onSearchChange={onSearchChange} />;
}
