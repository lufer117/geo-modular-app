/**
 * ui/municipioSelector.js
 *
 * Selector de municipio (presentación). Renderiza un calcite-combobox y
 * delega en la estrategia de ámbito lo que ocurre al elegir.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Solo UI: construir el combobox (con agrupación por provincia cuando
 * procede), leer la selección del usuario y llamar a la estrategia. NO sabe
 * cómo se cargan las capas ni qué diferencia hay entre un ámbito
 * monomunicipal y uno supramunicipal: eso vive en core/ambito/ (patrón
 * Strategy, ver crearEstrategia.js para el contrato).
 *
 *   elegir municipio  → estrategia.seleccionar(codigoIne)
 *   limpiar selección → estrategia.limpiar()
 *
 * ── POR QUÉ SE EXTRAJO LA CARGA DE CAPAS ─────────────────────────────────
 * Antes este módulo contenía tres pipelines de carga y un if por ámbito.
 * Mezclaba presentación con orquestación de capas y obligaba a editarlo
 * para cada ámbito nuevo (comarca). Ahora la UI es idéntica para cualquier
 * ámbito y un ámbito nuevo no la toca (SRP + abierto/cerrado).
 *
 * ── CALLBACKS HACIA LA ESTRATEGIA ────────────────────────────────────────
 * Las estrategias no importan de ui/ (core no depende de presentación). En
 * su lugar, main.js les pasa dos callbacks que este módulo exporta:
 *   setLoadingSelector(bool)   → spinner del combobox
 *   limpiarSeleccionSelector() → deja el combobox sin selección visible
 *
 * ── SELECTOR UI: calcite-combobox ────────────────────────────────────────
 * selection-mode="single" (no "single-persist"): el usuario puede
 * deseleccionar, y eso dispara estrategia.limpiar() (en ámbito
 * supramunicipal vuelve a la vista territorial base; en monomunicipal no
 * hace nada). Ver 3DECISIONS.md 04.08.26.
 *
 * ── AGRUPACIÓN POR PROVINCIA ─────────────────────────────────────────────
 * Cuando municipiosDisponibles cruza varias provincias (ccaa multiprovincial,
 * ej. País Vasco), el combobox agrupa los municipios bajo un
 * <calcite-combobox-item-group> por provincia, sin forzar un drill-down de
 * dos pasos: el usuario sigue escribiendo el nombre del municipio. Con una
 * sola provincia se renderiza la lista plana (un único grupo repitiendo el
 * mismo nombre no aporta nada). Ver _agruparPorProvincia() y
 * _necesitaAgrupacion().
 *
 * ── LO QUE NO HACE ───────────────────────────────────────────────────────
 * No instancia capas, no emite eventos de carga, no toca el mapa, no decide
 * qué municipios son visibles (territorioResolver).
 */

import { clearContainer }         from "../utils/domUtils.js";
import { on }                     from "../utils/eventBus.js";
import { t }                      from "../utils/i18nManager.js";

// ─── Estado interno del módulo ─────────────────────────────────────────────

let _containerEl              = null;
let _estrategia               = null;
let _municipiosDisponibles    = [];
let _idiomaListenerRegistrado = false;

/**
 * codigo_ine del municipio en foco. Fachada de solo lectura sobre la
 * estrategia (headerControls la consume). La fuente de verdad del estado es
 * la estrategia, no este módulo.
 */
export function getMunicipioActivo() {
  return _estrategia?.getMunicipioActivo() ?? null;
}

/**
 * Renderiza el selector de municipio en el contenedor indicado.
 *
 * @param {HTMLElement|string} container - Elemento DOM o selector CSS
 * @param {Object} estrategia - Estrategia de ámbito (ver core/ambito/crearEstrategia.js)
 * @param {Object[]} municipiosDisponibles - Ya resueltos por
 *   territorioResolver para el ámbito activo del deployment
 */
export function renderMunicipioSelector(container, estrategia, municipiosDisponibles = []) {
  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    console.error("[municipioSelector] Contenedor no encontrado:", container);
    return;
  }

  _containerEl           = el;
  _estrategia            = estrategia;
  _municipiosDisponibles = municipiosDisponibles;

  clearContainer(el);

  _registrarListenerIdioma();

  if (_municipiosDisponibles.length === 0) {
    console.warn("[municipioSelector] Ningún municipio disponible para este deployment");
    return;
  }

  // ── Carga automática: sin selector en el DOM ─────────────────────────────
  // La estrategia decide si el usuario debe elegir (monomunicipal con un
  // único municipio no elige: se carga solo en estrategia.iniciar()).
  if (_estrategia.cargaAutomatica()) {
    return; // sale sin construir ningún elemento DOM
  }

  // ── Selector Calcite — calcite-combobox con autocompletado ───────────────
  const label = document.createElement("calcite-label");
  label.setAttribute("layout", "inline");
  label.textContent = t("nav.municipio.label");

  const combobox = document.createElement("calcite-combobox");
  combobox.id = "municipio-select"; // setLoadingSelector() y
                                    // limpiarSeleccionSelector() lo buscan por id
  combobox.setAttribute("selection-mode", "single");
  combobox.setAttribute("placeholder", t("nav.municipio.placeholder"));
  combobox.setAttribute("label", t("nav.municipio.placeholder"));

  // Agrupación por provincia: ver docstring del módulo.
  const grupos = _agruparPorProvincia(_municipiosDisponibles);

  if (_necesitaAgrupacion(grupos)) {
    [...grupos.values()]
      .sort((a, b) => a.label.localeCompare(b.label, "es"))
      .forEach(grupo => {
        const groupEl = document.createElement("calcite-combobox-item-group");
        groupEl.setAttribute("label", grupo.label);

        grupo.municipios
          .slice()
          .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
          .forEach(m => groupEl.appendChild(_crearComboboxItem(m)));

        combobox.appendChild(groupEl);
      });
  } else {
    _municipiosDisponibles
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
      .forEach(m => combobox.appendChild(_crearComboboxItem(m)));
  }

  combobox.addEventListener("calciteComboboxChange", _onMunicipioChange);

  label.appendChild(combobox);
  el.appendChild(label);
}

// ─── Callbacks para las estrategias (ver docstring del módulo) ─────────────

/** Muestra u oculta el spinner de carga del combobox Calcite. */
export function setLoadingSelector(isLoading) {
  const select = document.getElementById("municipio-select");
  if (!select) return;
  isLoading
    ? select.setAttribute("loading", "")
    : select.removeAttribute("loading");
}

/**
 * Deja el <calcite-combobox> sin selección visible. A diferencia de
 * <calcite-select>, calcite-combobox no se limpia con .value = "": el
 * estado vive en cada calcite-combobox-item, vía su propiedad "selected".
 */
export function limpiarSeleccionSelector() {
  const combobox = document.getElementById("municipio-select");
  if (combobox) {
    combobox.querySelectorAll("calcite-combobox-item[selected]")
      .forEach(item => { item.selected = false; });
  }
}

// ─── Helpers de agrupación ─────────────────────────────────────────────────

/**
 * Agrupa municipios por provincia, indexado por provincia_code (estable;
 * provincia_nombre es solo para mostrar).
 *
 * @param {Object[]} municipiosVisibles
 * @returns {Map<string, {label: string, municipios: Object[]}>}
 */
function _agruparPorProvincia(municipiosVisibles) {
  const grupos = new Map();

  for (const m of municipiosVisibles) {
    const clave = m.provincia_code ?? "_sin_provincia";
    const label = m.provincia_nombre ?? m.provincia_code ?? "—";

    if (!grupos.has(clave)) {
      grupos.set(clave, { label, municipios: [] });
    }
    grupos.get(clave).municipios.push(m);
  }

  return grupos;
}

/** Con 0 o 1 provincia distinta, agrupar no aporta nada: lista plana. */
function _necesitaAgrupacion(grupos) {
  return grupos.size > 1;
}

/** Construye un <calcite-combobox-item> para un municipio (DRY entre ramas). */
function _crearComboboxItem(m) {
  const item = document.createElement("calcite-combobox-item");
  item.value   = m.codigo_ine;
  item.heading = `${m.nombre}`;
  if (_estrategia?.getMunicipioActivo() === m.codigo_ine) {
    item.selected = true;
  }
  return item;
}

// ─── Handlers privados ─────────────────────────────────────────────────────

/**
 * Handler de calciteComboboxChange. Con selection-mode="single",
 * event.target.selectedItems es un array de 0 o 1 elementos; vacío = el
 * usuario limpió la búsqueda. La UI no distingue ámbitos: la estrategia
 * activa sabe qué hacer en cada caso.
 */
async function _onMunicipioChange(event) {
  const codigoIne = event.target.selectedItems?.[0]?.value ?? "";

  if (!codigoIne) {
    await _estrategia.limpiar();
  } else {
    await _estrategia.seleccionar(codigoIne);
  }
}

function _registrarListenerIdioma() {
  if (_idiomaListenerRegistrado) return;
  _idiomaListenerRegistrado = true;

  on("idioma-cambiado", () => {
    if (_containerEl && _estrategia) {
      renderMunicipioSelector(_containerEl, _estrategia, _municipiosDisponibles);
    }
  });
}