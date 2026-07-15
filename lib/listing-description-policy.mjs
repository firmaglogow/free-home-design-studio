const PORTAL_SECTION_BOUNDARY = /\n\s*(?:#{1,4}\s*)?(?:\*\*)?(?:Sugestie tytułów|Tytuły na portale)(?:\*\*)?\s*:?[ \t]*(?=\n|$)/i;

export function cleanCrmPortalDescription(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const stop = /^(?:#{1,4}\s*)?(?:sugestie tytułów|tytuły na portale|marketplace|facebook|instagram|sms|youtube|kontrola danych|pytania do właściciela|pytania do klienta|atuty ze zdjęć|materiały marketingowe)\s*:?\s*$/i;
  const kept = [];

  for (const line of lines) {
    const plain = line.replace(/[*_]/g, "").trim();
    if (stop.test(plain)) break;
    if (/^(?:#{1,4}\s*)?opis (?:na portale|portalowy|oferty)\s*:?\s*$/i.test(plain)) continue;
    kept.push(line);
  }

  return kept.join("\n").replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
}

export function listingPortalFooter(propertyType) {
  const ending = {
    apartment: "Serdecznie zapraszamy na prezentację tego mieszkania. Skontaktuj się z nami i zobacz na żywo jego układ, lokalizację oraz możliwości.",
    house: "Serdecznie zapraszamy na prezentację tego domu. Skontaktuj się z nami i zobacz na żywo jego układ, standard oraz możliwości.",
    commercial: "Serdecznie zapraszamy na prezentację tego lokalu. Skontaktuj się z nami i zobacz na żywo jego przestrzeń, lokalizację oraz możliwości.",
    plot: "Serdecznie zapraszamy na prezentację tej działki. Skontaktuj się z nami i poznaj na miejscu jej położenie, otoczenie oraz możliwości.",
    other: "Serdecznie zapraszamy na prezentację tej nieruchomości. Skontaktuj się z nami i zobacz na żywo jej najważniejsze atuty oraz możliwości.",
  }[propertyType] || "Serdecznie zapraszamy na prezentację tej nieruchomości. Skontaktuj się z nami i zobacz na żywo jej najważniejsze atuty oraz możliwości.";

  return `**FREE HOME nieruchomości Głogów**\n${ending}`;
}

export function enforceListingPortalOpening(value) {
  const source = String(value || "").replace(/\r/g, "").trim();
  if (!source) return source;

  const portalBoundary = source.search(PORTAL_SECTION_BOUNDARY);
  const portal = portalBoundary >= 0 ? source.slice(0, portalBoundary) : source;
  const remainder = portalBoundary >= 0 ? source.slice(portalBoundary) : "";
  const firstDetailHeading = /^(?:#{1,4}\s*)?(?:\*\*)?Lokalizacja(?:\*\*)?\s*:?\s*$/im;
  const headingMatch = firstDetailHeading.exec(portal);
  if (!headingMatch) return source;

  const beforeHeading = portal.slice(0, headingMatch.index);
  const afterHeading = portal.slice(headingMatch.index);
  const hasPortalLabel = /^(?:#{1,4}\s*)?(?:\*\*)?Opis (?:na portale|portalowy|oferty)(?:\*\*)?\s*:?\s*$/im.test(beforeHeading);
  const boldFragments = [...beforeHeading.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((match) => match[1].trim())
    .filter((text) => !/^Opis (?:na portale|portalowy|oferty)$/i.test(text));

  if (!boldFragments.length) return source;

  const opening = boldFragments.slice(0, 2).join(" ").replace(/\s+/g, " ").trim().toLocaleUpperCase("pl-PL");
  const label = hasPortalLabel ? "**Opis na portale**\n" : "";
  return `${label}**${opening}**\n\n${afterHeading.trimStart()}${remainder}`.trim();
}

export function ensureListingPortalFooter(value, propertyType) {
  const source = String(value || "").replace(/\r/g, "").trim();
  if (!source) return source;

  const boundary = source.search(PORTAL_SECTION_BOUNDARY);
  let portal = (boundary >= 0 ? source.slice(0, boundary) : source).trimEnd();
  const remainder = boundary >= 0 ? source.slice(boundary) : "";
  const brand = /(?:\*\*)?FREE HOME nieruchomości Głogów(?:\*\*)?/i;
  const match = brand.exec(portal);
  const footer = listingPortalFooter(propertyType);

  if (!match) {
    portal += `\n\n${footer}`;
  } else {
    portal = `${portal.slice(0, match.index).trimEnd()}\n\n${footer}`;
  }

  return `${portal}${remainder}`.trim();
}

export function normalizeCrmPortalDescription(value, propertyType) {
  return ensureListingPortalFooter(
    enforceListingPortalOpening(
      cleanCrmPortalDescription(
        ensureListingPortalFooter(enforceListingPortalOpening(value), propertyType),
      ),
    ),
    propertyType,
  );
}
