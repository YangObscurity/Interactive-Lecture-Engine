export declare function migrateLegacyConceptLinks(
  markdown: string,
  resolveTerm?: (slug: string) => string | undefined,
): { nextMarkdown: string; replacements: number }
