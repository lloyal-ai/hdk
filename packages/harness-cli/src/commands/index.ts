import type { Command } from '../command.js';
import { newCommand } from './new.js';
import { appCommand } from './app.js';
import { installCommand } from './install.js';
import { publishCommand } from './publish.js';
import { publishersCommand } from './publishers.js';
import { reviewCommand } from './review.js';
import { modelsCommands } from './models.js';
import { targetsCommands } from './targets.js';

/** Named subcommands, in help-listing order. */
export const SUBCOMMANDS: readonly Command[] = [
  appCommand,
  ...modelsCommands,
  ...targetsCommands,
  installCommand,
  publishCommand,
  publishersCommand,
  reviewCommand,
];

/**
 * Resolve a typed token to a command. `new` (harness scaffold) plus the named
 * subcommands (`app:new`, `install`, …); an unknown token returns undefined so
 * the dispatcher errors instead of scaffolding.
 */
export function findCommand(name: string): Command | undefined {
  if (name === newCommand.name) return newCommand;
  return SUBCOMMANDS.find((c) => c.name === name);
}
