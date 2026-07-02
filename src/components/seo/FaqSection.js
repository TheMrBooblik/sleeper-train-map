/**
 * Renders a compact FAQ as native <details> accordions. The answers live in the
 * DOM (crawlable) whether open or closed, so this pairs cleanly with FAQPage
 * JSON-LD emitted by the page. Renders nothing when there are no items.
 *
 * @param {{ items: {q:string,a:string}[] }} props
 */
export default function FaqSection({ items }) {
  if (!items || items.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold text-white">Frequently asked questions</h2>
      <div className="mt-4 divide-y divide-white/10 rounded-xl border border-white/10 bg-white/[0.02]">
        {items.map((item) => (
          <details key={item.q} className="group px-4">
            <summary className="flex cursor-pointer items-center justify-between gap-3 py-3.5 text-sm font-medium text-white/90 marker:content-none">
              {item.q}
              <span className="text-white/40 transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="pb-4 text-sm leading-relaxed text-white/60">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
