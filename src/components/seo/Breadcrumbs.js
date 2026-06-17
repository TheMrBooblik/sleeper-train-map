import Link from "next/link";
import { FaChevronRight } from "react-icons/fa";
import JsonLd from "./JsonLd";
import { absoluteUrl } from "../../lib/seo/site";

/**
 * Visual breadcrumb trail + a schema.org BreadcrumbList.
 * @param {{ items: { name: string, href?: string }[] }} props
 *   items are ordered root → current; the last item is the current page.
 */
export default function Breadcrumbs({ items = [] }) {
  if (!items.length) return null;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      ...(item.href ? { item: absoluteUrl(item.href) } : {}),
    })),
  };

  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm text-white/40">
        <ol className="flex flex-wrap items-center gap-2">
          {items.map((item, i) => (
            <li key={`${item.name}-${i}`} className="flex items-center gap-2">
              {item.href && i < items.length - 1 ? (
                <Link href={item.href} className="hover:text-white/70 transition-colors">
                  {item.name}
                </Link>
              ) : (
                <span className="text-white/60">{item.name}</span>
              )}
              {i < items.length - 1 && (
                <FaChevronRight className="w-2.5 h-2.5 text-white/20" />
              )}
            </li>
          ))}
        </ol>
      </nav>
      <JsonLd data={jsonLd} />
    </>
  );
}
