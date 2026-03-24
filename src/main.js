import { inject } from '@vercel/analytics'

inject()

const COMMENT_WORK_IDS = new Set([
  'matthaeus-judentum',
  'taufe-jesu-synoptisch',
  'lukas-identitaet-sendung',
])
const WORK_IDS_ALLOWED = new Set([
  'markus-historisch',
  'matthaeus-judentum',
  'taufe-jesu-synoptisch',
  'lukas-identitaet-sendung',
])

const PDF_PATH_MATT = '/AntijudaismusbeiMattheaus.pdf'
const PDF_PATH_TAUFFE = '/DieTaufeJesu.pdf'
const PDF_PATH_LUKAS = '/SoteriologieimEvangeliumnachLukas.pdf'

/** Pfad segmentweise kodieren (Fallback, z. B. wenn new URL fehlschlägt) */
function pdfEncodedPath(path) {
  if (!path || !path.startsWith('/')) return encodeURI(path || '')
  const segs = path
    .slice(1)
    .split('/')
    .map((s) => encodeURIComponent(s))
  return `/${segs.join('/')}`
}

/** Gleiche Kodierung wie der Browser für Pfade mit Leerzeichen/Umlauten (zuverlässiger als nur encodeURIComponent pro Segment). */
function pdfAbsoluteUrl(path) {
  try {
    return new URL(path, window.location.origin).href
  } catch {
    return `${window.location.origin}${pdfEncodedPath(path)}`
  }
}

/**
 * Mehrere mögliche Pfade (gleicher sichtbarer Name, unterschiedliche Unicode-Normalisierung /
 * Tippfehler bei ä), weil Server (z. B. Linux/Vercel) und Mac-Dateinamen oft auseinanderlaufen.
 */
function pdfCandidatePaths(path) {
  const out = []
  const seen = new Set()
  const add = (p) => {
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  add(path)
  try {
    add(path.normalize('NFC'))
    add(path.normalize('NFD'))
  } catch {
    /* ignore */
  }
  const i = path.lastIndexOf('/')
  const dir = i >= 0 ? path.slice(0, i + 1) : '/'
  const file = i >= 0 ? path.slice(i + 1) : path
  const umlautAe = file
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
  add(dir + umlautAe)
  add(dir + file.replace(/ä/g, 'a').replace(/Ä/g, 'A'))
  return out
}

async function fetchPdfFirstOk(paths, signal) {
  for (const p of paths) {
    const fetchUrl = pdfAbsoluteUrl(p)
    try {
      const res = await fetch(fetchUrl, { signal, credentials: 'same-origin' })
      if (res.ok) return { res, fetchUrl }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
  }
  throw new Error('pdf not found')
}

const PDF_PREVIEW_HINT_DEFAULT =
  'In der Live-Umgebung wird hier das Dokument eingebettet.'
const PDF_PREVIEW_HINT_ERROR =
  'PDF konnte nicht geladen werden. Liegt die Datei im Ordner public/ und stimmt der Dateiname exakt (inkl. Umlaut ä vs. ae)?'

let pdfPreviewAbortController = null
let pdfPreviewBlobUrl = null
let pdfPreviewSession = 0

function teardownPdfPreview() {
  if (pdfPreviewAbortController) {
    pdfPreviewAbortController.abort()
    pdfPreviewAbortController = null
  }
  if (pdfPreviewBlobUrl) {
    URL.revokeObjectURL(pdfPreviewBlobUrl)
    pdfPreviewBlobUrl = null
  }
}

function blobAsPdf(blob) {
  const t = blob.type || ''
  if (t === 'application/pdf') return blob
  return new Blob([blob], { type: 'application/pdf' })
}

/** @type {{ fetchUrl: string, fileName: string } | null} */
let detailPdfDownload = null

/** Einheitlicher Hinweis unter dem Abstract jeder Arbeit (Detailansicht). */
const WORK_LEGAL_FOOTER_HTML = `
<p class="pt-8 mt-8 border-t border-stone-200 text-[11px] text-stone-500 leading-relaxed">
  Diese Arbeit ist urheberrechtlich geschützt. Vervielfältigung, Verbreitung oder öffentliche Wiedergabe — auch auszugsweise — nur mit Zustimmung des Urhebers.
</p>
`

const TAUFFE_BODY_HTML = `
<p class="text-sm text-stone-600 mb-4">Synoptischer Vergleich und außerkanonische Rezeption der Tauf- und Versuchungstradition</p>
<p>Die Arbeit untersucht die Erzählung der Taufe Jesu und die direkt anschließende Versuchungsgeschichte als zentrales Motiv der frühchristlichen Identitätsbildung. Ausgehend vom Markusevangelium als ältestem Zeugnis wird analysiert, wie sich die Darstellung Jesu von einem initialen Berufungserlebnis hin zu einer hochgradig mythologisch aufgeladenen Legitimationsgeschichte entwickelt. Dabei steht die Frage im Vordergrund, wie die verschiedenen Autoren mit dem „historischen Problem“ umgehen, dass sich der sündlose Messias einer Bußtaufe durch Johannes unterzieht.</p>
<p class="font-semibold text-black pt-1">Zentrale Aspekte der Untersuchung:</p>
<ul class="list-disc pl-5 space-y-3 mt-2">
<li><span class="font-semibold text-gray-900">Exegetische Analyse der Basiselemente:</span> Untersuchung der Motive „geöffneter Himmel“, „Geisttaube“ und „Himmelsstimme“ vor dem Hintergrund des Alten Testaments (z.&nbsp;B. Jes&nbsp;63) und der hellenistischen Umwelt.</li>
<li><span class="font-semibold text-gray-900">Synoptischer Vergleich (Mk, Mt, Lk):</span> Aufzeigen der redaktionellen Strategien zur Entlastung Jesu und zur Unterordnung des Täufers – von der neutralen Darstellung bei Markus bis zur expliziten Rechtfertigung bei Matthäus und der Relativierung durch das Gebet bei Lukas.</li>
<li><span class="font-semibold text-gray-900">Die Versuchung als Bewährung:</span> Analyse der Versuchungsgeschichte (unter Einbeziehung der Logienquelle Q) als notwendige Erprobung der messianischen Würde, wobei Jesus als das „neue Israel“ oder der „neue Mose“ typologisch gedeutet wird.</li>
<li><span class="font-semibold text-gray-900">Transformation im Johannesevangelium:</span> Untersuchung der radikalen Umdeutung, bei der die Taufe als Akt zugunsten eines rein zeugnishaften Auftretens des Täufers in den Hintergrund tritt.</li>
<li><span class="font-semibold text-gray-900">Außerkanonische Ausweitung (Ebionitenevangelium, Justin):</span> Analyse späterer Zusätze wie des „Licht- oder Feuermotivs“ und der Adoptionstheologie (Ps&nbsp;2,7), die eine fortschreitende Mystifizierung des Ereignisses belegen.</li>
</ul>
<p class="pt-2">Die Arbeit kommt zu dem Schluss, dass die Tauferzählung einen Prozess der zunehmenden Mythologisierung durchläuft. Während der historische Kern der Taufe aufgrund seiner Sperrigkeit als gesichert gelten kann, dienen die literarischen Ausschmückungen dazu, die christologische Einzigartigkeit Jesu gegenüber der Johannesbewegung zu behaupten und seine göttliche Sohnschaft zu proklamieren.</p>
`

const MATT_BODY_HTML = `
<p>Die Arbeit setzt sich mit der komplexen Darstellung jüdischer Gruppierungen im Matthäusevangelium auseinander. Dabei wird untersucht, wie der Verfasser – selbst tief in der jüdischen Tradition verwurzelt – sprachliche und narrative Mittel einsetzt, um eine Distanzierung von den religiösen Autoritäten seiner Zeit zu vollziehen. Die Untersuchung konzentriert sich auf die Frage, inwieweit diese Polemik als Ausdruck eines innerjüdischen Konflikts oder als früher Keim eines christlichen Antijudaismus zu werten ist.</p>
<p class="font-semibold text-black pt-1">Zentrale Aspekte der Untersuchung:</p>
<ul class="list-disc pl-5 space-y-3 mt-2">
<li><span class="font-semibold text-gray-900">Narrative Feindbildkonstruktion:</span> Analyse der literarischen Techniken, mit denen bestimmte Gruppierungen als Kontrastfiguren zur Botschaft Jesu gezeichnet werden.</li>
<li><span class="font-semibold text-gray-900">Identitäts- und Grenzziehung:</span> Untersuchung der rhetorischen Strategien, die dazu dienen, die eigene Gemeinschaft gegenüber der Mehrheitsgesellschaft zu definieren und zu legitimieren.</li>
<li><span class="font-semibold text-gray-900">Soziokultureller Kontext:</span> Einordnung der Texte in das Spannungsfeld nach der Zerstörung des Zweiten Tempels, geprägt von der Suche nach religiöser Neuorientierung.</li>
<li><span class="font-semibold text-gray-900">Wirkungsgeschichtliche Relevanz:</span> Reflexion über die langfristigen Folgen der matthäischen Polemik für das Verhältnis zwischen Christentum und Judentum.</li>
</ul>
<p class="pt-2">Ziel der Arbeit ist es, die Motive hinter der harten Wortwahl des Evangelisten offenzulegen und die Grenze zwischen theologischer Auseinandersetzung und pauschaler Herabwürdigung zu bestimmen.</p>
`

const LUKAS_BODY_HTML = `
<p class="text-sm text-stone-600 mb-4">Die Transformation der markinischen Vorlage in der Tauferzählung und der Erlösungslehre des Lukasevangeliums</p>
<p>Diese Forschungsarbeit untersucht die redaktionelle Gestaltung des Jesusbildes bei Lukas im Vergleich zur markinischen Tradition. Dabei werden zwei Schwerpunkte gesetzt: die Identitätsstiftung durch die Taufe und Versuchung sowie die daraus resultierende Soteriologie (Erlösungslehre).</p>
<p class="font-semibold text-black pt-4">1. Die Taufe Jesu: Von der Vision zur Legitimation</p>
<p>Der erste Teil der Arbeit analysiert die motivgeschichtliche Entwicklung der Tauferzählung. Während Markus das Ereignis als privates Berufungserlebnis Jesu schildert, verstärkt Lukas den öffentlich-offiziellen Charakter.</p>
<ul class="list-disc pl-5 space-y-3 mt-2">
<li><span class="font-semibold text-gray-900">Mythologische Motive:</span> Die Untersuchung der Geisttaube und der Himmelsstimme zeigt, wie Lukas Jesus als den mit Geist begabten messianischen Zeugen legitimiert.</li>
<li><span class="font-semibold text-gray-900">Versuchung als Bewährung:</span> Die Versuchungsgeschichte wird als notwendige Konsequenz der Taufe interpretiert, in der Jesus die Treue zu seinem Auftrag unter Beweis stellt und als „neues Israel“ triumphiert.</li>
</ul>
<p class="font-semibold text-black pt-4">2. Die Soteriologie: Umkehr statt Sühneopfer</p>
<p>Der zweite Teil widmet sich der Frage, wie Lukas das Ziel der Sendung Jesu definiert. Durch einen detaillierten Vergleich mit dem Markusevangelium wird nachgewiesen, dass Lukas eine eigenständige Soteriologie entwirft:</p>
<ul class="list-disc pl-5 space-y-3 mt-2">
<li><span class="font-semibold text-gray-900">Ablehnung des Lösegeldmotivs:</span> Lukas streicht konsequent markinische Formulierungen, die Jesu Tod als Sühneopfer deuten (z.&nbsp;B. Mk&nbsp;10,45).</li>
<li><span class="font-semibold text-gray-900">Der gerechte Diener:</span> Anstelle eines rituellen Opfertodes tritt das Motiv des Dienstes und der Gerechtigkeit. Jesus rettet nicht durch sein Blut, sondern durch seinen Ruf zur Metanoia (Umkehr).</li>
<li><span class="font-semibold text-gray-900">Abendmahl und Vergebung:</span> Die Analyse der <span class="italic">lectio brevior</span> des lukanischen Abendmahls zeigt, dass das gemeinsame Mahl als Zeichen der Gemeinschaft und des Teilens verstanden wird, während die sühnetheologische Deutung des Blutes in den Hintergrund tritt.</li>
</ul>
<p class="font-semibold text-black pt-4">Fazit</p>
<p>Die Arbeit zeigt auf, dass Lukas das Leben und Sterben Jesu in einer konsequenten Linie zeichnet: Von der Geistempfängnis bei der Taufe bis zum Tod als gerechter Zeuge. Die Erlösung ist bei Lukas kein mechanischer Akt am Kreuz, sondern ein durch Jesus initiierter Prozess der Umkehr und der Neuausrichtung auf Gott.</p>
`

/** Erweiterte Detailseiten: optional PDF-Vorschau + Download */
const WORK_EXTENDED = {
  'matthaeus-judentum': {
    bodyHtml: MATT_BODY_HTML + WORK_LEGAL_FOOTER_HTML,
    pdf: {
      path: PDF_PATH_MATT,
      fileName: 'AntijudaismusbeiMattheaus.pdf',
      label: 'Antijudaismus bei Mattheaus',
    },
  },
  'taufe-jesu-synoptisch': {
    bodyHtml: TAUFFE_BODY_HTML + WORK_LEGAL_FOOTER_HTML,
    pdf: {
      path: PDF_PATH_TAUFFE,
      fileName: 'DieTaufeJesu.pdf',
      label: 'Die Taufe Jesu',
    },
  },
  'lukas-identitaet-sendung': {
    bodyHtml: LUKAS_BODY_HTML + WORK_LEGAL_FOOTER_HTML,
    pdf: {
      path: PDF_PATH_LUKAS,
      fileName: 'SoteriologieimEvangeliumnachLukas.pdf',
      label: 'Soteriologie im Evangelium nach Lukas',
    },
  },
}

let commentReplyParentId = null

/** Dynamischer Import verhindert, dass Vite Supabase bei leerem .env komplett entfernt. */
async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = import.meta.env.VITE_SUPABASE_URL || ''
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
  if (!url || !key) return null
  return createClient(url, key)
}

function handleImageError(element) {
  element.src =
    'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&q=80&w=800'
}

function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

function formatCommentDate(iso) {
  try {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

function buildTree(rows) {
  const byId = new Map()
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      body: r.body,
      authorLabel: (r.author_name && String(r.author_name).trim()) || 'Anonym',
      createdAt: r.created_at,
      replies: [],
    })
  }
  const roots = []
  for (const r of rows) {
    const node = byId.get(r.id)
    if (r.parent_id) {
      const parent = byId.get(r.parent_id)
      if (parent) parent.replies.push(node)
      else roots.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (list) => {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    list.forEach((n) => sortRec(n.replies))
  }
  sortRec(roots)
  return roots
}

/** @param {{ path: string, fileName: string, label: string } | null} pdf */
function applyPdfDetailView(showPdf, pdf) {
  const ph = document.getElementById('detail-preview-placeholder')
  const pdfWrap = document.getElementById('detail-pdf-frame-wrap')
  const iframe = document.getElementById('detail-pdf-iframe')
  const dl = document.getElementById('detail-download')
  const dlWrap = document.getElementById('detail-download-wrap')
  const pdfLabel = document.getElementById('detail-pdf-label')
  if (!ph || !pdfWrap || !iframe || !dl || !dlWrap) return
  const hintEl = document.getElementById('detail-preview-hint')

  if (showPdf && pdf) {
    const session = ++pdfPreviewSession
    teardownPdfPreview()
    if (hintEl) hintEl.textContent = PDF_PREVIEW_HINT_DEFAULT

    const candidates = pdfCandidatePaths(pdf.path)
    ph.classList.add('hidden')
    pdfWrap.classList.remove('hidden')
    iframe.src = 'about:blank'

    dl.href = '#'
    dl.setAttribute('download', pdf.fileName)
    detailPdfDownload = null
    dlWrap.classList.add('hidden')
    if (pdfLabel) {
      pdfLabel.textContent = `Dokumentenvorschau — ${pdf.label}`
    }

    pdfPreviewAbortController = new AbortController()
    const { signal } = pdfPreviewAbortController

    ;(async () => {
      try {
        const { res, fetchUrl } = await fetchPdfFirstOk(candidates, signal)
        if (session !== pdfPreviewSession) return
        if (signal.aborted) return
        const blob = await res.blob()
        if (session !== pdfPreviewSession) return
        if (signal.aborted) return
        pdfPreviewBlobUrl = URL.createObjectURL(blobAsPdf(blob))
        iframe.src = pdfPreviewBlobUrl
        dl.href = fetchUrl
        detailPdfDownload = { fetchUrl, fileName: pdf.fileName }
        dlWrap.classList.remove('hidden')
        if (hintEl) hintEl.textContent = PDF_PREVIEW_HINT_DEFAULT
      } catch (e) {
        if (e?.name === 'AbortError' || signal.aborted) return
        if (session !== pdfPreviewSession) return
        teardownPdfPreview()
        iframe.src = ''
        ph.classList.remove('hidden')
        pdfWrap.classList.add('hidden')
        dl.href = '#'
        dl.removeAttribute('download')
        dlWrap.classList.add('hidden')
        detailPdfDownload = null
        if (hintEl) hintEl.textContent = PDF_PREVIEW_HINT_ERROR
      }
    })()
  } else {
    pdfPreviewSession += 1
    teardownPdfPreview()
    detailPdfDownload = null
    if (hintEl) hintEl.textContent = PDF_PREVIEW_HINT_DEFAULT
    ph.classList.remove('hidden')
    pdfWrap.classList.add('hidden')
    iframe.src = ''
    dl.href = '#'
    dl.removeAttribute('download')
    dlWrap.classList.add('hidden')
    if (pdfLabel) {
      pdfLabel.textContent = 'Dokumentenvorschau'
    }
  }
}

function openDetail(workId, title, description, status) {
  document.getElementById('detail-work-id').value = workId
  document.getElementById('detail-title').innerText = title
  document.getElementById('detail-status').innerHTML =
    `<span class="status-badge border-stone-200 text-stone-500">${escapeHtml(status)}</span>`

  const descEl = document.getElementById('detail-description')
  const extEl = document.getElementById('detail-extended')

  const extended = WORK_EXTENDED[workId]
  if (extended) {
    descEl.classList.add('hidden')
    descEl.textContent = ''
    extEl.classList.remove('hidden')
    extEl.innerHTML = extended.bodyHtml
    applyPdfDetailView(!!extended.pdf, extended.pdf || null)
  } else {
    descEl.classList.remove('hidden')
    descEl.innerText = description
    extEl.classList.add('hidden')
    extEl.innerHTML = ''
    applyPdfDetailView(false, null)
  }

  document.getElementById('detail-view').style.display = 'block'
  document.body.style.overflow = 'hidden'
  window.scrollTo({ top: 0 })

  const wrap = document.getElementById('comments-section-wrap')
  if (COMMENT_WORK_IDS.has(workId)) {
    wrap.classList.remove('hidden')
    loadComments()
  } else {
    wrap.classList.add('hidden')
  }
}

function closeDetail() {
  closeCommentModal()
  applyPdfDetailView(false, null)
  document.getElementById('detail-view').style.display = 'none'
  document.body.style.overflow = 'auto'
}

function renderCommentBranch(c) {
  const article = document.createElement('article')
  article.className = 'comment-card'
  const meta = document.createElement('div')
  meta.className = 'flex flex-wrap items-baseline gap-2 text-sm'
  meta.innerHTML =
    '<span class="font-semibold text-black">' +
    escapeHtml(c.authorLabel) +
    '</span><time class="text-xs text-gray-400">' +
    escapeHtml(formatCommentDate(c.createdAt)) +
    '</time>'
  const p = document.createElement('p')
  p.className = 'text-gray-700 leading-relaxed mt-2 whitespace-pre-wrap'
  p.textContent = c.body
  const replyBtn = document.createElement('button')
  replyBtn.type = 'button'
  replyBtn.className = 'mt-3 text-[10px] uppercase tracking-widest text-stone-500 hover:text-black'
  replyBtn.textContent = 'Antworten'
  replyBtn.addEventListener('click', () => {
    openCommentModal(c.id)
  })
  article.appendChild(meta)
  article.appendChild(p)
  article.appendChild(replyBtn)
  if (c.replies && c.replies.length) {
    const repliesWrap = document.createElement('div')
    repliesWrap.className = 'comment-replies space-y-4'
    c.replies.forEach((r) => {
      repliesWrap.appendChild(renderCommentBranch(r))
    })
    article.appendChild(repliesWrap)
  }
  return article
}

async function loadComments() {
  const workId = document.getElementById('detail-work-id').value
  const list = document.getElementById('comments-list')
  const statusEl = document.getElementById('comments-status')
  list.innerHTML = ''
  statusEl.classList.add('hidden')
  statusEl.textContent = ''

  const supabase = await getSupabase()
  if (!supabase) {
    statusEl.textContent =
      'Kommentare: Bitte VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY setzen (z. B. in Vercel unter Environment Variables).'
    statusEl.classList.remove('hidden')
    return
  }

  try {
    const { data, error } = await supabase
      .from('work_comments')
      .select('id, work_id, parent_id, body, author_name, created_at')
      .eq('work_id', workId)
      .order('created_at', { ascending: true })

    if (error) {
      statusEl.textContent = 'Kommentare konnten nicht geladen werden.'
      statusEl.classList.remove('hidden')
      return
    }

    const tree = buildTree(data || [])
    if (tree.length === 0) {
      list.innerHTML = '<p class="text-sm text-gray-400 italic">Noch keine Kommentare.</p>'
      return
    }
    tree.forEach((c) => {
      list.appendChild(renderCommentBranch(c))
    })
  } catch {
    statusEl.textContent = 'Kommentare sind hier nicht erreichbar.'
    statusEl.classList.remove('hidden')
  }
}

function openCommentModal(parentId) {
  commentReplyParentId = parentId || null
  const modal = document.getElementById('comment-modal')
  const h = document.getElementById('comment-modal-heading')
  h.textContent = commentReplyParentId ? 'Antwort schreiben' : 'Kommentar hinzufügen'
  document.getElementById('comment-modal-text').value = ''
  document.getElementById('comment-modal-name').value = ''
  modal.classList.add('is-open')
  document.getElementById('comment-modal-text').focus()
}

function closeCommentModal() {
  document.getElementById('comment-modal').classList.remove('is-open')
  commentReplyParentId = null
}

async function submitComment() {
  const workId = document.getElementById('detail-work-id').value
  const text = document.getElementById('comment-modal-text').value.trim()
  const name = document.getElementById('comment-modal-name').value.trim()
  if (!text) return

  if (!WORK_IDS_ALLOWED.has(workId)) {
    alert('Ungültige Arbeit.')
    return
  }

  const btn = document.getElementById('comment-modal-submit')
  btn.disabled = true
  try {
    const supabase = await getSupabase()
    if (!supabase) {
      alert('Kommentare sind nicht konfiguriert.')
      return
    }

    const row = {
      work_id: workId,
      parent_id: commentReplyParentId,
      body: text.slice(0, 4000),
      author_name: name ? name.slice(0, 80) : null,
    }

    const { error } = await supabase.from('work_comments').insert(row)

    if (error) {
      alert('Senden fehlgeschlagen. Bitte später erneut versuchen.')
      return
    }
    closeCommentModal()
    loadComments()
  } catch {
    alert('Netzwerkfehler — bitte später erneut versuchen.')
  } finally {
    btn.disabled = false
  }
}

document.getElementById('detail-download')?.addEventListener('click', async (e) => {
  const cfg = detailPdfDownload
  if (!cfg) return
  e.preventDefault()
  try {
    const res = await fetch(cfg.fetchUrl, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('fetch failed')
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blobAsPdf(blob))
    const a = document.createElement('a')
    a.href = objUrl
    a.download = cfg.fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objUrl)
  } catch {
    window.open(cfg.fetchUrl, '_blank', 'noopener,noreferrer')
  }
})

document.getElementById('btn-add-comment').addEventListener('click', () => {
  openCommentModal(null)
})
document.getElementById('comment-modal-cancel').addEventListener('click', closeCommentModal)
document.getElementById('comment-modal-submit').addEventListener('click', submitComment)
document.getElementById('comment-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('comment-modal')) closeCommentModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCommentModal()
})

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const observerOptions = { threshold: 0.12, rootMargin: '0px 0px -5% 0px' }
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('opacity-100', 'translate-y-0')
      entry.target.classList.remove('opacity-0', 'translate-y-8')
    }
  })
}, observerOptions)

document.querySelectorAll('section').forEach((section) => {
  if (prefersReducedMotion) {
    section.classList.add('opacity-100', 'translate-y-0')
  } else {
    section.classList.add('section-fade', 'opacity-0', 'translate-y-8')
    observer.observe(section)
  }
})

;(function navScrollShadow() {
  const nav = document.getElementById('site-nav')
  if (!nav) return
  const onScroll = () => {
    if (window.scrollY > 16) nav.classList.add('nav--shadow')
    else nav.classList.remove('nav--shadow')
  }
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
})()

;(function () {
  const btn = document.getElementById('mobile-menu-btn')
  const menu = document.getElementById('mobile-menu')
  if (!btn || !menu) return
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('hidden')
    btn.setAttribute('aria-expanded', String(!open))
  })
  menu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      menu.classList.add('hidden')
      btn.setAttribute('aria-expanded', 'false')
    })
  })
})()

window.handleImageError = handleImageError
window.openDetail = openDetail
window.closeDetail = closeDetail
