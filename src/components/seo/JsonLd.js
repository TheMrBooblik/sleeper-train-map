/**
 * Tiny helper to emit a JSON-LD <script> block (schema.org structured data).
 * Mirrors the inline pattern used on the existing about page.
 */
export default function JsonLd({ data }) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
