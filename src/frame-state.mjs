export function collectFrameState({ maxTextChars, maxElements }) {
  const REF_ATTRIBUTE = "data-responses-ref";
  document.querySelectorAll(`[${REF_ATTRIBUTE}]`).forEach((element) => {
    element.removeAttribute(REF_ATTRIBUTE);
  });

  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return element.getAttribute("aria-hidden") !== "true"
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && rect.width > 0
      && rect.height > 0;
  };

  const clean = (value, limit = 160) => String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

  const accessibleName = (element) => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ");
    const labels = element.labels ? [...element.labels].map((label) => label.innerText).join(" ") : "";
    const type = element.getAttribute("type")?.toLowerCase();
    const safeValue = ["button", "submit", "reset"].includes(type) ? element.value : "";
    return clean(
      element.getAttribute("aria-label")
      || labelledBy
      || labels
      || element.getAttribute("alt")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.innerText
      || safeValue
      || element.getAttribute("name"),
    );
  };

  const selector = [
    "a[href]",
    "button",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "summary",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='tab']",
    "[role='menuitem']",
  ].join(",");

  const elements = [...document.querySelectorAll(selector)]
    .filter(isVisible)
    .slice(0, maxElements)
    .map((element, index) => {
      const ref = `e${index + 1}`;
      element.setAttribute(REF_ATTRIBUTE, ref);
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute("type")?.toLowerCase() || "";
      const item = {
        ref,
        tag,
        role: element.getAttribute("role") || "",
        type,
        name: type === "password" ? "[password field]" : accessibleName(element),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      };

      if (type === "checkbox" || type === "radio") item.checked = Boolean(element.checked);
      if (tag === "select") {
        item.value = element.value;
        item.options = [...element.options].slice(0, 50).map((option) => ({
          value: option.value,
          label: clean(option.label, 100),
          selected: option.selected,
        }));
      }
      if (type === "file") item.file = true;
      return item;
    });

  const bodyText = (document.body?.innerText || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: document.title,
    text: bodyText.slice(0, maxTextChars),
    textTruncated: bodyText.length > maxTextChars,
    elements,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      pageHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight),
    },
  };
}
