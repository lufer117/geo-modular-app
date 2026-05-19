/**
 * utils/domUtils.js
 *
 * Helpers DOM reutilizables sin dependencia de ArcGIS.
 * Centraliza operaciones DOM comunes para mantener DRY
 * y evitar repetición en módulos de UI.
 *
 * PRINCIPIO: ningún módulo debería escribir `document.createElement`
 * con atributos inline dispersos por el código. Estos helpers
 * estandarizan la creación de elementos y operaciones frecuentes.
 */

/**
 * Crea un elemento HTML con atributos y texto opcionales.
 * @param {string} tag
 * @param {Object} attrs  - { atributo: valor }
 * @param {string} [text] - textContent opcional
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs = {}, text = "") {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (text) el.textContent = text;
  return el;
}

/**
 * Muestra un elemento eliminando la clase CSS "hidden".
 * Usamos clase CSS en lugar de display:none — Web Components first:
 * manipular display directamente puede romper el shadow DOM de Calcite.
 * @param {HTMLElement} el
 */
export function show(el) {
  el?.classList.remove("hidden");
}

/**
 * Oculta un elemento añadiendo la clase CSS "hidden".
 * @param {HTMLElement} el
 */
export function hide(el) {
  el?.classList.add("hidden");
}

/**
 * Vacía el contenido de un contenedor de forma segura.
 * @param {HTMLElement} container
 */
export function clearContainer(container) {
  if (!container) return;
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
}

/**
 * Selecciona un elemento del DOM y lanza un error descriptivo si no existe.
 * Útil para detectar errores de configuración en el HTML al arrancar.
 * @param {string} selector
 * @param {string} [context] - nombre del módulo llamante (para el error)
 * @returns {HTMLElement}
 */
export function requireElement(selector, context = "app") {
  const el = document.querySelector(selector);
  if (!el) {
    throw new Error(`[${context}] Elemento requerido no encontrado: "${selector}"`);
  }
  return el;
}