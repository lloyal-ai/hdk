/**
 * The service contract, consumer side: the services a harness can provide and an ability can require,
 * how a bound one is reached, and what an unconfigured one says.
 *
 * A service is every model beside the trunk llm, by the name that is also its block in `harness.yml`
 * (`model.reranker`) and its slot on disk (`models/reranker/`). Naming the block is enabling the service.
 * What a bound service exposes is its own: the reranker scores, tokenizes and disposes; a service with no
 * members is a {@link Trunk} marker for a capability the resident context gained.
 *
 * The set is closed. Adding a service is a key here, its name in {@link SERVICES}, its keys in
 * `modelSettings` and its provider in `providers/` — the compiler names whichever is missing. The
 * platform side — how a provider binds, derives and folds — is `@lloyal-labs/rig/node`'s `providers`.
 *
 * @packageDocumentation
 * @category Rig
 */
import { createContext } from 'effection';
import type { Operation } from 'effection';
import type { Embedder, Reranker } from './retrieval';

export interface ServiceMap {
  /** The pointwise judge the abilities score with. */
  reranker: Reranker;
  /** The trunk can see: the projector is on the resident context. No members — sight is the context's, not an
   *  object's; what a consumer reads is that it is there. */
  vision: Trunk;
  /** The encoder a harness indexes with, one vector per text. */
  embedding: Embedder;
}

/** A service that is a capability of the trunk rather than an instance of its own: the artifact the platform put
 *  on the resident context, and nothing to call. */
export interface Trunk {
  readonly artifact: string;
}

/** A service's name — also its config block and its slot. */
export type Service = keyof ServiceMap;

/** The names, as a runtime list, for what parses a manifest. Exhaustive against {@link ServiceMap}. */
export const SERVICES = ['reranker', 'vision', 'embedding'] as const satisfies readonly Service[];
const _everyServiceNamed: Exclude<Service, (typeof SERVICES)[number]> extends never ? true : never = true;
void _everyServiceNamed;

/**
 * Effection context holding every bound service, by name — what the harness bound from its `model.<name>`
 * blocks, and what the registry seeds into each ability's scope. Read through {@link service}; set by the
 * platform's provisioning, never by a consumer.
 *
 * @category Contract
 */
export const Services = createContext<Partial<ServiceMap>>('lloyal.services', {});

/**
 * The one way a harness or an ability reaches a service: the bound instance, or a refusal that names the block
 * whose presence would bind it. Availability, not permission — any scope under the binding reads it, whether
 * or not it declared the service.
 *
 * @category Contract
 */
export function* service<K extends Service>(name: K): Operation<ServiceMap[K]> {
  const bound = (yield* Services.get())?.[name];
  if (!bound) throw new Error(`\`${name}\` is not configured — add \`model.${name}\` to harness.yml`);
  return bound;
}
