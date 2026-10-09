import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const toolName = z.enum(['get_line_snapshot', 'get_equipment_snapshot', 'get_maintenance_history']);
const skillSchema = z.object({
  id: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1), purpose: z.string().min(1), when: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  allowed_tools: z.array(toolName).min(1), required_tools: z.array(toolName).min(1),
  failure_policy: z.string().min(1),
}).strict().refine((skill) => skill.required_tools.every((name) => skill.allowed_tools.includes(name)),
  'Required tools must be allowed');

export type Skill = z.infer<typeof skillSchema>;

export function loadSkills(base = join(process.cwd(), 'src', 'skills')): Skill[] {
  const skills = ['line-diagnosis.json', 'equipment-patrol.json'].map((file) =>
    skillSchema.parse(JSON.parse(readFileSync(join(base, file), 'utf8'))));
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) throw new Error('Duplicate skill IDs');
  return skills;
}

export function selectSkill(skills: Skill[], question: string, requested?: string): Skill {
  if (requested) {
    const chosen = skills.find((skill) => skill.id === requested);
    if (!chosen) throw new Error('Unknown skill');
    return chosen;
  }
  return skills.find((skill) => skill.id ===
    (/巡检|优先级|检查顺序|patrol|priority/i.test(question) ? 'equipment-priority-patrol' : 'line-anomaly-diagnosis'))!;
}
