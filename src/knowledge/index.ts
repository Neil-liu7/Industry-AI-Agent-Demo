import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Repository } from '../storage/repository';

const documentSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), case_ids: z.array(z.string()).min(1),
  version: z.string().min(1), updated_at: z.iso.date(), keywords: z.array(z.string().min(2)).min(1),
  summary: z.string().min(1), checks: z.array(z.string().min(1)).min(1),
}).strict();
const librarySchema = z.object({
  version: z.string().min(1), data_type: z.literal('synthetic'),
  documents: z.array(documentSchema).min(1),
}).strict();

export type KnowledgeLibrary = z.infer<typeof librarySchema>;
export type KnowledgeMatch = KnowledgeLibrary['documents'][number] & { matched_terms: string[] };

export function loadKnowledgeLibrary(repository: Repository, path = join(process.cwd(), 'data', 'knowledge.json')): KnowledgeLibrary {
  const library = librarySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const caseIds = new Set(repository.listCases().map((item) => item.case_id));
  if (new Set(library.documents.map((item) => item.id)).size !== library.documents.length ||
    library.documents.some((item) => item.case_ids.some((id) => !caseIds.has(id)))) {
    throw new Error('Knowledge library has duplicate IDs or unknown cases');
  }
  return library;
}

export function searchKnowledge(library: KnowledgeLibrary, caseId: string, query: string): KnowledgeMatch[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 100) throw new Error('Query must be 2–100 characters');
  return library.documents
    .filter((item) => item.case_ids.includes(caseId))
    .map((item) => ({ ...item, matched_terms: item.keywords.filter((term) => normalized.includes(term.toLowerCase())) }))
    .filter((item) => item.matched_terms.length > 0)
    .sort((left, right) => right.matched_terms.length - left.matched_terms.length || left.id.localeCompare(right.id))
    .slice(0, 5);
}
