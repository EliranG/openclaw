import type { ApplicationContext } from "../../app/context.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import { SystemsController, type SystemsRouteData } from "./systems-controller.ts";
import { SystemsPage } from "./systems-page.tsx";
import { SystemsSidebar } from "./systems-sidebar.tsx";

/** Route rendering stays in the lazy page module, not in startup route metadata. */
export function render(data: SystemsRouteData | undefined, _pending: boolean, presented = true) {
  return data ? solidContent(SystemsPage, { routeData: data, presented }) : undefined;
}

export function renderSidebar(data: SystemsRouteData | undefined) {
  return data ? solidContent(SystemsSidebar, { controller: data.controller }) : undefined;
}

export function load(context: ApplicationContext): SystemsRouteData {
  return { controller: new SystemsController(context) };
}
