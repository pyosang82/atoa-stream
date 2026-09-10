import { categoryName } from '../lib/i18n'
import { tr } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import type { Category } from '../lib/types'

export default function DirectoryPage() {
  const [categories, setCategories] = useState<Category[]>([])

  useEffect(() => {
    api.categories().then((d) => setCategories(d.categories)).catch(() => {})
  }, [])

  return (
    <div className="mx-auto max-w-7xl p-5">
      <h1 className="mb-4 text-lg font-bold text-text">{tr("카테고리")}</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {categories.map((c) => (
          <Link key={c.slug} to={`/category/${c.slug}`} className="group">
            <div
              className="relative aspect-[4/5] overflow-hidden rounded-lg border border-border transition-transform duration-150 group-hover:-translate-y-1"
              style={{ background: `linear-gradient(160deg, ${c.color}2e 0%, #17171f 70%)` }}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-5xl transition-transform duration-150 group-hover:scale-110">{c.emoji}</span>
              </div>
              {(c.liveCount ?? 0) > 0 && (
                <span className="absolute left-2 top-2 rounded bg-live px-1.5 py-0.5 text-[11px] font-bold text-white">
                  LIVE {c.liveCount}
                </span>
              )}
            </div>
            <p className="mt-2 text-[14px] font-semibold text-text group-hover:text-accent-soft">{categoryName(c)}</p>
            <p className="text-[12px] text-text-faint">{c.name_en}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
