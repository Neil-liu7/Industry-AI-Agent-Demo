import { describe, expect, it } from 'vitest';
import { calculateMetrics, caseSchema } from '../src/domain/cases';
import { Repository } from '../src/storage/repository';

describe('synthetic cases and deterministic metrics', () => {
  const repository = new Repository(':memory:');
  repository.seed();

  it('imports five distinct fixed cases', () => {
    expect(repository.listCases().map((item) => item.case_id)).toEqual([
      'IND-001', 'IND-002', 'IND-003', 'IND-004', 'IND-005',
    ]);
    expect(repository.getMaintenance('IND-001', 'EQ-003')?.record_id).toBe('MAINT-003');
    expect(repository.getMaintenance('IND-001', 'EQ-002')).toBeNull();
  });

  it('calculates units, changes and risk for the anomaly', () => {
    const metrics = calculateMetrics(repository.getCase('IND-001')!);
    expect(metrics.output_change_pct).toBeCloseTo(-15);
    expect(metrics.baseline_defect_rate_pct).toBeCloseTo(2);
    expect(metrics.current_defect_rate_pct).toBeCloseTo(3.5294, 3);
    expect(metrics.defect_rate_change_pp).toBeCloseTo(1.5294, 3);
    expect(metrics.temperature_change_pct).toBeCloseTo(25);
    expect(metrics.vibration_change_pct).toBeCloseTo(35);
    expect(metrics.risk_level).toBe('HIGH');
  });

  it('classifies normal, single-metric and incomplete-data cases', () => {
    expect(calculateMetrics(repository.getCase('IND-002')!).risk_level).toBe('LOW');
    expect(calculateMetrics(repository.getCase('IND-003')!).risk_level).toBe('MEDIUM');
    expect(calculateMetrics(repository.getCase('IND-004')!).risk_level).toBe('UNKNOWN');
    expect(calculateMetrics(repository.getCase('IND-004')!).temperature_change_pct).toBeNull();
    expect(calculateMetrics(repository.getCase('IND-005')!).risk_level).toBe('MEDIUM');
    expect(calculateMetrics(repository.getCase('IND-005')!).vibration_change_pct).toBeCloseTo(25);
  });

  it('applies the same threshold boundaries to temporary what-if values', () => {
    const original = repository.getCase('IND-001')!;
    const scenario = (daily_output_units: number, temperature_c: number, vibration_mm_s: number) =>
      calculateMetrics({
        baseline_date: original.baseline_date, snapshot_date: original.snapshot_date,
        baseline: original.baseline,
        current: { ...original.current, daily_output_units, temperature_c, vibration_mm_s },
      }).risk_level;
    expect(scenario(900, 84, 6)).toBe('HIGH');
    expect(scenario(950, 84, 6)).toBe('MEDIUM');
    expect(scenario(950, 75, 6)).toBe('LOW');
    expect(scenario(0, 75, 6)).toBe('UNKNOWN');
    expect(calculateMetrics(original).risk_level).toBe('HIGH');
  });

  it('does not infer risk from missing data, zero baseline or invalid windows', () => {
    const base = repository.getCase('IND-001')!;
    for (const data of [
      { ...base, current: { ...base.current, temperature_c: null } },
      { ...base, baseline: { ...base.baseline, daily_output_units: 0 } },
      { ...base, baseline_date: base.snapshot_date },
    ]) {
      const parsed = caseSchema.parse(data);
      expect(calculateMetrics(parsed).risk_level).toBe('UNKNOWN');
    }
    const invalidWindow = caseSchema.parse({ ...base, baseline_date: base.snapshot_date });
    expect(calculateMetrics(invalidWindow)).toEqual({
      output_change_pct: null, baseline_defect_rate_pct: null, current_defect_rate_pct: null,
      defect_rate_change_pp: null, temperature_change_pct: null, vibration_change_pct: null,
      risk_level: 'UNKNOWN',
    });
  });

  it('allows shutdown cleanup to close a repository more than once', () => {
    const temporary = new Repository(':memory:');
    temporary.close();
    expect(() => temporary.close()).not.toThrow();
  });
});
