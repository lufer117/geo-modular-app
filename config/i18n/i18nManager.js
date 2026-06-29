/**
 * config/i18n/i18nManager.js
 *
 * Motor de internacionalización (i18n) de la aplicación.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Es el ÚNICO módulo que sabe de idiomas. Centraliza:
 *   - Resolución del idioma activo (URL > localStorage > deployment)
 *   - Carga del JSON de traducciones correspondiente
 *   - Aplicación de textos estáticos al DOM via atributos data-i18n
 *   - Exposición de t() para textos dinámicos generados por JS
 *   - Cambio de idioma en runtime con actualización reactiva del DOM
 *
 * ── POR QUÉ UN MÓDULO CENTRAL ────────────────────────────────────────────
 * Distribuir la lógica de idioma entre módulos (toolbar, layerTree, etc.)
 * crearía dependencias cruzadas y dificultaría añadir un nuevo idioma.
 * Con este módulo, añadir un idioma = añadir un JSON + una línea en deployment.
 *
 * ── ESTRATEGIA DE ACTUALIZACIÓN EN RUNTIME ───────────────────────────────
 * Textos estáticos del shell (index.html): atributos data-i18n → init() los aplica.
 * Textos dinámicos (árbol de capas, mensajes de estado): t() en cada módulo JS.
 * Al cambiar idioma: actualiza el idioma activo, reaplica el DOM estático
 * y emite un evento para que los módulos que generan texto en JS se refresquen.
 *
 * ── LIMITACIÓN DOCUMENTADA ───────────────────────────────────────────────
 * esriConfig.locale se establece desde window.__GIS_LANG__ en el script inline
 * de index.html, ANTES de que el SDK cargue. En primera visita sin ?lang= en
 * la URL, el SDK carga con el fallback del script inline ('es'), no con
 * idioma_defecto de deployment.js (que aún no existe en ese momento).
 * Trabajo futuro: SSR o endpoint que sirva el locale antes de la carga del SDK.
 */

import { DEPLOYMENT } from "../deployment.js";
import { emit } from "../../utils/eventBus.js";

// ── Constantes ──────────────────────────────────────────────────────────────
const STORAGE_KEY  = "geo-app-lang";
// Idiomas que el sistema conoce. Añadir aquí + crear su JSON es suficiente.
const IDIOMAS_SOPORTADOS = ["es", "en", "eu", "gl", "ca", "va"];

// Traducciones cargadas en memoria. null hasta que init() resuelve.
let _traducciones = null;

// Idioma activo en esta sesión.
let _langActivo = "es";

// ── API pública ─────────────────────────────────────────────────────────────

/**
 * Inicializa el sistema i18n.
 * Debe llamarse en main.js ANTES de montar cualquier módulo de UI.
 *
 * @returns {Promise<void>}
 */

export async function init() {
  const traduccionesResueltas = await _resolverYcargarIdioma();
  _langActivo = traduccionesResueltas.lang;
  _traducciones = traduccionesResueltas.traducciones;

  // Sincronizar el <html lang=""> con el idioma activo
  document.documentElement.lang = _langActivo;

  // Aplicar textos estáticos del shell (elementos con data-i18n en index.html)
  _aplicarDOM();

  console.info(`[i18n] Idioma activo: ${_langActivo}`);
}

/**
 * Devuelve el texto traducido para una clave dada.
 * Si la clave no existe en el idioma activo, devuelve la clave como fallback
 * para que sea visible en UI y fácil de detectar durante el desarrollo.
 *
 * @param {string} key - Clave de traducción (ej: "layers.empty")
 * @returns {string}
 */

export function t(key) {
  if (!_traducciones) {
    console.warn(`[i18n] t("${key}") llamado antes de init(). Retornando clave.`);
    return key;
  }
  return _traducciones[key] ?? key; 
}

/**
 * Devuelve el idioma activo.
 * @returns {string} Código ISO 639-1 (ej: "es", "eu", "en")
 */
export function getLang() {
  return _langActivo;
}

/**
 * Cambia el idioma en runtime sin recargar la página.
 * 1. Carga el JSON de traducciones del idioma destino
 * 2. Notifica al SDK de ArcGIS vía intl.setLocale() → Web Components se actualizan
 * 3. Re-aplica data-i18n al DOM estático
 * 4. Emite "idioma-cambiado" → módulos JS rehidratan sus textos dinámicos
 *
 * @param {string} code - Código ISO del idioma destino (ej: "eu")
 */

export async function setLang(code) {
  // Validar que el idioma es soportado por el sistema Y por el deployment actual
  const idiomasPermitidos = DEPLOYMENT.idiomas ?? ["es"];
  if (!idiomasPermitidos.includes(code)) {
    console.warn(`[i18n] Idioma "${code}" no está en deployment.idiomas:`, idiomasPermitidos);
    return;
  }

  if (code === _langActivo) return; // No recargar si ya estamos en ese idioma

  const traduccionesResueltas = await _cargarTraducciones(code);

  _langActivo = traduccionesResueltas.lang;
  _traducciones = traduccionesResueltas.traducciones;

  // Persistir el idioma realmente resuelto para que el siguiente arranque
  // recupere exactamente la misma localización que la UI está mostrando.
  localStorage.setItem(STORAGE_KEY, _langActivo);

  document.documentElement.lang = _langActivo;

  //notificar al SDK de ArcGIS
  // intl.setLocale() actualiza automáticamente todos los Web Components
  // del SDK (arcgis-legend, arcgis-zoom, etc.) y los de Calcite.
  // Es experimental según Esri pero cubre exactamente nuestro caso de uso:
  // no usamos labels de FeatureLayer ni expresiones Arcade en la UI de idioma

  const intl = await $arcgis.import("esri/intl");
  intl.setLocale(_langActivo);

  _aplicarDOM();

  // Los módulos con texto generado en JS se rehidratan escuchando este evento.
  emit("idioma-cambiado", { lang: _langActivo });
}

// ── Privado ─────────────────────────────────────────────────────────────────

async function _resolverYcargarIdioma() {
  const lang = _resolverIdioma();
  return await _cargarTraducciones(lang);
}

/**
 * Resuelve el idioma activo aplicando las prioridades definidas:
 *   1. ?lang= en la URL
 *   2. localStorage
 *   3. deployment.idioma_defecto
 *   4. "es" como último fallback
 *
 * Solo acepta idiomas que estén tanto en IDIOMAS_SOPORTADOS como en
 * DEPLOYMENT.idiomas. Esto evita que un parámetro URL malformado
 * active un idioma que el cliente no tiene configurado.
 */
function _resolverIdioma() {
  const permitidos = (DEPLOYMENT.idiomas ?? ["es"])
    .filter(l => IDIOMAS_SOPORTADOS.includes(l));

  // Prioridad 1: ?lang= en URL
  const urlLang = new URLSearchParams(location.search).get("lang");
  if (urlLang && permitidos.includes(urlLang)) return urlLang;

  // Prioridad 2: localStorage
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && permitidos.includes(stored)) return stored;

  // Prioridad 3: deployment.idioma_defecto
  const defecto = DEPLOYMENT.idioma_defecto;
  if (defecto && permitidos.includes(defecto)) return defecto;

  // Prioridad 4: fallback absoluto
  return "es";
}

/**
 * Carga el JSON de traducciones del idioma indicado.
 * Si falla (fichero no encontrado, JSON malformado), cae al español.
 *
 * @param {string} lang
 * @returns {Promise<Object>}
 */
async function _cargarTraducciones(lang) {
  try {
    const res = await fetch(`../config/i18n/${lang}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      lang,
      traducciones: await res.json()
    };
  } catch (err) {
    console.warn(`[i18n] No se pudo cargar "${lang}.json", usando "es" como fallback:`, err);

    // Fallback: intentar cargar español
    if (lang !== "es") {
      const res = await fetch("../config/i18n/es.json");
      return {
        lang: "es",
        traducciones: await res.json()
      };
    }
    return {
      lang: "es",
      traducciones: {}
    }; // Si ni español carga, devolver objeto vacío (t() retornará la clave)
  }
}

/**
 * Aplica las traducciones al DOM estático del shell (index.html).
 * Se ejecuta una vez en init(), después de cargar el JSON de traducciones.
 * El reload garantiza un DOM limpio en cada cambio de idioma.
 *
 * ── DOS ESTRATEGIAS ──────────────────────────────────────────────────────
 *
 * A) data-i18n  [atributo único o textContent]
 *    Para elementos con un solo texto a traducir.
 *
 *    Sin data-i18n-attr → actualiza textContent:
 *      <span data-i18n="layers.empty"></span>
 *
 *    Con data-i18n-attr → actualiza el atributo indicado del Web Component:
 *      <calcite-block data-i18n="panel.basemap.heading"
 *                     data-i18n-attr="heading">
 *
 * B) data-i18n-props  [múltiples atributos en el mismo elemento]
 *    Para Web Components Calcite que exponen varios atributos de texto
 *    (heading, description, label, placeholder...).
 *    Evita multiplicar data-i18n2, data-i18n3... que escalan mal.
 *
 *    Valor: JSON inline con { nombreAtributo: "clave.i18n" }
 *      <calcite-panel
 *        data-i18n-props='{"heading":"panel.layers.heading",
 *                          "description":"panel.layers.description"}'>
 *
 *    _aplicarDOM() itera las entradas y llama setAttribute por cada una.
 *    Si el JSON está malformado, emite console.warn y continúa con el
 *    siguiente elemento para no bloquear el resto de traducciones.
 *
 * ── REGLA DE USO ─────────────────────────────────────────────────────────
 *    - 1 atributo o textContent  →  data-i18n  [+ data-i18n-attr opcional]
 *    - 2 o más atributos         →  data-i18n-props
 *    Nunca mezclar ambos en el mismo elemento.
 */
function _aplicarDOM() {
  // ── Estrategia A: un atributo o textContent ──────────────────────────
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key  = el.getAttribute("data-i18n");
    const attr = el.getAttribute("data-i18n-attr");
    const text = t(key);

    if (attr) {
      el.setAttribute(attr, text);
    } else {
      el.textContent = text;
    }
  });

  // ── Estrategia B: múltiples atributos vía JSON inline ───────────────
  document.querySelectorAll("[data-i18n-props]").forEach(el => {
    try {
      const props = JSON.parse(el.getAttribute("data-i18n-props"));
      Object.entries(props).forEach(([attr, key]) => {
        el.setAttribute(attr, t(key));
      });
    } catch (err) {
      console.warn("[i18n] data-i18n-props malformado en elemento:", el, err);
    }
  });
}