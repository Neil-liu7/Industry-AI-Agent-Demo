import { describe, expect, it } from 'vitest';
import { calculateMetrics, caseSchema } from '../src/domain/cases';
import { Repository } from '../src/storage/repository';

describe('synthetic cases and deterministic metrics', () => {
  const repository = new Repository(':memory:');
  repository.seed();

  it('imports three distinct fixed cases', () => {
    expect(repository.listCases().map((item) => item.case_id)).toEqual(['IND-001', 'IND-002', 'IND-003']);
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

  it('classifies the control and single-metric anomaly', () => {
    expect(calculateMetrics(repository.getCase('IND-002')!).risk_level).toBe('LOW');
    expect(calculateMetrics(repository.getCase('IND-003')!).risk_level).toBe('MEDIUM');
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
  });
});
