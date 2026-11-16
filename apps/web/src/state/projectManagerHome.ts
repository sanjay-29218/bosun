import {
  applyManagerPlacement,
  type ManagerCopy,
  managerCopiesOf,
  type PlacedProject,
  planManagerPlacement,
} from "@t3tools/client-runtime/project-manager-home";
import { useEffect } from "react";

import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { useEnvironments } from "./environments";
import { useQuietThreadShells } from "./entities";
import { formatEnvironmentQueryError } from "./query";
import { rolesEnvironment } from "./roles";
import { useAtomCommand } from "./use-atom-command";

/** Copies of a project on environments that keep one manager per project, for placement. */
export function useManagerCopies(): (projects: ReadonlyArray<PlacedProject>) => ManagerCopy[] {
  const shells = useQuietThreadShells();
  const { environments } = useEnvironments();
  return (projects) =>
    managerCopiesOf({
      projects: projects.filter(
        (project) =>
          environments.find((environment) => environment.environmentId === project.environmentId)
            ?.serverConfig?.environment.capabilities.projectManagerHomes === true,
      ),
      labelOf: (environmentId) =>
        environments.find((environment) => environment.environmentId === environmentId)?.label ??
        null,
      threads: shells,
    });
}

/** Sends a placement plan; resolves to the failure's message, or null once every write landed. */
export function useApplyManagerPlacement() {
  const place = useAtomCommand(rolesEnvironment.setProjectManagerPlacement, {
    reportFailure: false,
  });
  return (
    plan: ReturnType<typeof planManagerPlacement>,
    copies: ReadonlyArray<ManagerCopy>,
  ): Promise<string | null> =>
    applyManagerPlacement(plan, copies, async ({ environmentId, input }) => {
      const result = await place({ environmentId, input });
      return result._tag === "Success"
        ? { ok: true, retiredThreadId: result.value.retiredThreadId }
        : { ok: false, failure: formatEnvironmentQueryError(result.cause) };
    });
}

// Once per placement a client tried this session, so a failure isn't retried on every render.
const attempted = new Set<string>();

/**
 * Gives each project on several machines one manager: when its copies don't agree on where the
 * manager lives, the default home keeps it and the others' managers retire. A copy on a machine
 * this client doesn't see leaves the project as it is; a client that may not change one logs why.
 */
export function useProjectManagerPlacementSync() {
  const groups = useSettingsProjectGroups();
  const copiesOf = useManagerCopies();
  const apply = useApplyManagerPlacement();
  const plans = groups.flatMap((group) => {
    const members = group.memberProjects.filter(
      (member) => member.isScratch !== true && member.isBotHome !== true,
    );
    if (members.length < 2) return [];
    const copies = copiesOf(members);
    // A copy this client can't place would be left out of the decision.
    if (copies.length !== members.length) return [];
    const plan = planManagerPlacement(copies);
    if (plan.away.length === 0 && plan.home === null) return [];
    return [{ key: JSON.stringify(plan), plan, copies }];
  });
  const pending = plans.filter(({ key }) => !attempted.has(key));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes each project's agreed manager home to its environments, once per placement.
  useEffect(() => {
    for (const { key, plan, copies } of pending) {
      if (attempted.has(key)) continue;
      attempted.add(key);
      void apply(plan, copies).then((failure) => {
        if (failure !== null) console.warn("Could not give a project one manager", failure);
      });
    }
  }, [pending, apply]);
}
