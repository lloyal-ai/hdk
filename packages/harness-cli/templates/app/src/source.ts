import { Source } from "@lloyal-labs/lloyal-agents";
import type { Tool } from "@lloyal-labs/lloyal-agents";
import { __NAME_PASCAL__SearchTool } from "./tools/search";
import { __NAME_PASCAL__FetchTool } from "./tools/fetch";

/**
 * Source for the __NAME__ app — exposes search + fetch tools.
 *
 * This scaffolded version calls Wikipedia's public REST so the app is
 * runnable out of the box. Replace the body of each tool's `execute`
 * method with calls to your actual __NAME__ backend, leaving the schema +
 * return shape intact.
 */
export class __NAME_PASCAL__Source extends Source {
  readonly name = "__NAME__";

  private _tools: Tool[];

  constructor() {
    super();
    this._tools = [new __NAME_PASCAL__SearchTool(), new __NAME_PASCAL__FetchTool()];
  }

  get tools(): Tool[] {
    return this._tools;
  }
}
