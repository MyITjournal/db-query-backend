export function determineAgeGroup(age) {
  if (age === null || age === undefined) return null;
  if (age > 0 && age <= 12) return "child";
  if (age >= 13 && age <= 19) return "teenager";
  if (age >= 20 && age <= 59) return "adult";
  return "senior";
}

export function constructLinks(req, page, limit, total) {
  const total_pages = Math.ceil(total / limit);
  const base = req.baseUrl + req.path;
  const params = { ...req.query };

  const makeUrl = (p) => {
    const q = new URLSearchParams({ ...params, page: p, limit }).toString();
    return `${base}?${q}`;
  };

  return {
    total_pages,
    links: {
      self: makeUrl(page),
      next: page < total_pages ? makeUrl(page + 1) : null,
      prev: page > 1 ? makeUrl(page - 1) : null,
    },
  };
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function getCountryName(countryCode) {
  if (!countryCode) return null;
  try {
    return regionNames.of(countryCode) ?? countryCode;
  } catch {
    return countryCode;
  }
}

export function formatProfile(r) {
  return {
    id: r.id,
    name: r.name,
    gender: r.gender,
    gender_probability: parseFloat(r.gender_probability),
    age: r.age,
    age_group: r.age_group,
    country_id: r.country_id,
    country_name: r.country_name ?? null,
    country_probability: parseFloat(
      parseFloat(r.country_probability).toFixed(2),
    ),
    created_at: r.created_at,
  };
}

export function handleUpstreamError(res, error) {
  console.error("[handleUpstreamError]", error.message, error.stack);
  const isUpstream =
    error.code === "ECONNABORTED" ||
    (error.response && error.response.status >= 500);
  return res.status(isUpstream ? 502 : 500).json({
    status: "error",
    message: "Server failure",
  });
}
