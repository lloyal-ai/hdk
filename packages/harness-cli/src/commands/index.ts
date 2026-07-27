import type { Command } from '../command.js';
import { createCommand } from './create.js';
import { appCommand } from './app.js';
import { installCommand } from './install.js';
import { publishCommand } from './publish.js';
import { publishersCommand } from './publishers.js';
import { reviewCommand } from './review.js';

/**
 * The default command — runs when no recognized subcommand is given
 * (bare `harness.dev <name>` scaffolds a harness). Also reachable as the
 * explicit `create` verb.
 */
export const DEFAULT_COMMAND = createCommand;

/** Named subcommands, in help-listing order. */
export const SUBCOMMANDS: readonly Command[] = [
  appCommand,
  installCommand,
  publishCommand,
  publishersCommand,
  reviewCommand,
];

/** Resolve a typed token to a subcommand (or the explicit `create` verb). */
export function findCommand(name: string): Command | undefined {
  if (name === createCommand.name) return createCommand;
  return SUBCOMMANDS.find((c) => c.name === name);
}
