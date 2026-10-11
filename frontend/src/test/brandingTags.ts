/**
 * Put branding into the test document the way the server puts it into index.html.
 * setup.ts clears it again after every test.
 */
export function setBrandingTags(tags: Record<string, string>): void {
  for (const [name, content] of Object.entries(tags)) {
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = content;
    document.head.appendChild(meta);
  }
}
