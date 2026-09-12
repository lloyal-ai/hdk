import type { AttachmentStore } from '@lloyal-labs/media';
import type { ContentIngress } from '@lloyal-labs/media';
import { sniffMediaType } from '@lloyal-labs/media';

/**
 * A ContentIngress that commits bytes verbatim — no normalization.
 *
 * FOR TESTS ONLY. A real ingress normalizes, which is what makes the stored
 * representation the exact bytes the projector decoded; this one exists so a
 * test can exercise the RAIL (markers, cells, position, ordering) without
 * pulling `sharp` into the agents test run. It records the omission on the
 * manifest so a stored artifact from a test is never mistaken for an admitted
 * one.
 */
export function rawIngress(store: AttachmentStore): ContentIngress {
  return {
    ingest: async (bytes) => {
      // The bytes decide, exactly as the real ingress does — this double
      // differs in skipping NORMALIZATION, not in who names the type.
      const rep = store.putBlob(bytes, sniffMediaType(bytes), {
        'ai.lloyal.derive.profile': 'test.raw',
      });
      return store.putAttachment({ representations: [rep] });
    },
  };
}
