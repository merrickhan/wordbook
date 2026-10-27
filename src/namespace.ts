// Namespace for this deployment's browser preferences (language, dictionary, legacy cleanup keys).
// It keeps the name and format of the former IndexedDB database name so existing preference keys
// remain readable. Words and categories are no longer stored in the browser.
export function databaseName(pageUrl: string): string {
  return `wordbook:${new URL('.', pageUrl).pathname}`;
}
