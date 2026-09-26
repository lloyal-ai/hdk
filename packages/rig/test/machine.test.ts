/**
 * The machine gate: can this box hold this model? A box under its class floor is refused before a
 * byte is fetched; every catalog llm names a class whose floor holds its weights with headroom; a
 * model with no class — a `path:` override — is not gated; the refusal states found-vs-needed, says
 * nothing was downloaded, and at the edge floor offers no smaller model, because there is none.
 */
import { describe, it, expect } from 'vitest';
import { checkMachine, gb, refusalMessage, MACHINE_CLASS_FLOOR_BYTES } from '../src/machine';
import { MODEL_CATALOG, catalogEntry } from '../src/models';

const GB = 1024 ** 3;

describe('checkMachine', () => {
  it('refuses a box under the class floor and passes one at it', () => {
    const edge = { machineClass: 'edge' as const };
    // The 8 GB Air this gate exists for.
    const small = checkMachine(edge, 8 * GB);
    expect(small?.ok).toBe(false);
    expect(small?.totalBytes).toBe(8 * GB);
    expect(small?.neededBytes).toBe(MACHINE_CLASS_FLOOR_BYTES.edge);
    // Exactly the floor passes: the floor is a minimum, not a threshold to clear.
    expect(checkMachine(edge, MACHINE_CLASS_FLOOR_BYTES.edge)?.ok).toBe(true);
    expect(checkMachine(edge, 16 * GB)?.ok).toBe(true);
  });

  it('holds the class boundary: 24 GB is an appliance, not a big edge box', () => {
    const appliance = { machineClass: 'appliance' as const };
    expect(checkMachine(appliance, 16 * GB)?.ok).toBe(false);
    expect(checkMachine(appliance, 24 * GB)?.ok).toBe(true);
    expect(MACHINE_CLASS_FLOOR_BYTES.appliance).toBe(24 * GB);
    expect(MACHINE_CLASS_FLOOR_BYTES.edge).toBe(10 * GB);
  });

  it('does not gate a model that names no class — trusted by possession', () => {
    expect(checkMachine({}, 1 * GB)).toBeNull();
  });
});

describe('the catalog declares what each model needs', () => {
  it('every llm names a machine class; a projector and a reranker name none — they ride their llm', () => {
    for (const m of MODEL_CATALOG) {
      if (m.role === 'llm') expect(m.machineClass, `catalog llm "${m.id}" names no machineClass`).toBeDefined();
      else expect(m.machineClass, `"${m.id}" (role ${m.role}) should not be gated`).toBeUndefined();
    }
  });

  it("each class's floor holds its model's weights and projector with headroom", () => {
    for (const m of MODEL_CATALOG.filter((m) => m.role === 'llm')) {
      const floor = MACHINE_CLASS_FLOOR_BYTES[m.machineClass!];
      const projector = m.vision ? (catalogEntry('vision', m.vision)?.sizeBytes ?? 0) : 0;
      expect(floor, `${m.id}: floor ${gb(floor)} under its own weights`).toBeGreaterThan(m.sizeBytes + projector);
    }
  });
});

describe('refusalMessage', () => {
  const verdict = checkMachine({ machineClass: 'edge' }, 8 * GB)!;

  it('states found vs needed, and that nothing was spent', () => {
    const msg = refusalMessage(verdict, 'Qwen3.5 4B · Q4_K_M');
    expect(msg).toContain('8 GB');
    expect(msg).toContain('10 GB');
    expect(msg).toContain('Nothing was downloaded');
  });

  it('offers no smaller model at the edge floor, because there is none', () => {
    expect(refusalMessage(verdict, 'Qwen3.5 4B · Q4_K_M')).toMatch(/no smaller model/i);
    const smallest = [...MODEL_CATALOG.filter((m) => m.role === 'llm')].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
    expect(smallest.machineClass).toBe('edge');
  });

  it('an appliance model on a small box is pointed at the edge tier instead', () => {
    const msg = refusalMessage(checkMachine({ machineClass: 'appliance' }, 16 * GB)!, 'Qwen3.8 27B · Q4_K_M');
    expect(msg).toMatch(/edge-class/i);
    expect(msg).not.toMatch(/no smaller model/i);
  });
});
