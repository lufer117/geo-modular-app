/**
 * ui/municipioSelector.js
 *
 * Selector de municipio. Punto de entrada del flujo de carga de datos.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Renderizar un selector Calcite y, al elegir un municipio, orquestar
 * el pipeline completo de carga:
 *
 *  El módulo ya NO decide qué municipios mostrar — eso lo resuelve
 *  config/territorioResolver.js (soporta ámbito municipio/provincia/ccaa).
 *  main.js llama a resolverAmbitoTerritorial() y pasa el array ya filtrado
 *  a renderMunicipioSelector(). Este módulo solo pinta lo que recibe.
 *
 *  Antes: importaba MUNICIPIOS estático y filtraba por deployment.municipios
 *  — lógica que hoy vive duplicada en territorioResolver para los otros
 *  ámbitos (provincia/ccaa). Eliminar la duplicación deja un único punto
 *  de verdad sobre "qué municipios se muestran", sin importar el ámbito.
 *
 *   configEngine.fetchCapas(municipioData)
 *       ↓  array de configs filtradas por cobertura
 *   layerFactory.crearCapa(config) × N   [en paralelo]
 *       ↓  instancias Esri
 *   layerInitializer.inicializarCapa(layer, config, municipioData) × N
 *       ↓  filtros runtime aplicados (BBOX / FILTRABLE / DIRECTA)
 *   mapManager.addCapas(layers)
 *       ↓  capas en el Map
 *   mapManager.actualizarMascara(polygon)
 *       ↓  recorte visual WMS actualizado
 *   mapManager.irAlMunicipio(bbox)
 *       ↓  zoom al municipio
 *   eventBus.emit("municipio-cargado")
 *       ↓  layerTree y legendPanel se actualizan
 *
 * ── LO QUE NO HACE ───────────────────────────────────────────────────────
 * No instancia capas directamente (delegado a layerFactory).
 * No construye el árbol DOM de capas (delegado a layerTree).
 * No conoce el formato de las capas Esri.
 * Ya NO decide qué municipios son visibles (delegado a territorioResolver).
 */


//  usuario interactúa con el select        1 solo municipio en la lista recibida
//         ↓                                           ↓
//   _onMunicipioChange(event)           carga automática al arrancar
//         ↓                                           ↓
//         └───────────── _cargarMunicipio(codigoIne) ──────────────┘
//                                     ↓
//                           [pipeline completo — sin cambios]

import * as configEngine         from "../config/configEngine.js";
import * as mapManager           from "../core/mapManager.js";
import { crearCapa }             from "../core/layerFactory.js";
import { inicializarCapa }       from "../core/layerInitializer.js";
import { emit }                  from "../utils/eventBus.js";
import { on }                    from "../utils/eventBus.js";
import { clearContainer }        from "../utils/domUtils.js";
import { t }                     from "../config/i18n/i18nManager.js";

// Semáforo: evitar doble carga si el usuario cambia de municipio rápidamente
let _cargando = false;
let _municipioActivo = null;
let _containerEl = null;
let _deploymentRef = { municipios: [] };
let _municipiosDisponibles = [];   // ← ya resuelto por territorioResolver, no se filtra aquí
let _idiomaListenerRegistrado = false;

export function getMunicipioActivo() {
  return _municipioActivo;
}

/**
 * API pública para cargar un municipio por código INE desde fuera del módulo.
 * Usada por main.js para restaurar el estado tras un cambio de idioma.
 * Delega en _cargarMunicipio para mantener DRY — un único pipeline.
 *
 * @param {string} codigoIne
 */
export async function cargarMunicipioPorCodigo(codigoIne) {
  await _cargarMunicipio(codigoIne);
}

/**
 * Renderiza el selector de municipio en el contenedor indicado.
 *
 * @param {HTMLElement|string} container - Elemento DOM o selector CSS
 * @param {Object[]} municipiosDisponibles - Array ya resuelto por
 *   territorioResolver.resolverAmbitoTerritorial() para el ámbito activo
 *   del deployment (municipio/provincia/ccaa). Mismo shape que
 *   data/municipios.json.
 * @param {Object} deployment - DEPLOYMENT de config/deployment.js. Ya no se
 *   usa para filtrar (eso ya vino resuelto en municipiosDisponibles) — se
 *   conserva como referencia para el listener de "idioma-cambiado".
 */
export function renderMunicipioSelector(container, municipiosDisponibles = [], deployment = { municipios: [] }) {
  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    console.error("[municipioSelector] Contenedor no encontrado:", container);
    return;
  }

  _containerEl = el;
  _deploymentRef = deployment;
  _municipiosDisponibles = municipiosDisponibles;

  clearContainer(el);

  _registrarListenerIdioma();

  const municipiosVisibles = _municipiosDisponibles;

  if (municipiosVisibles.length === 0) {
    console.warn(
      "[municipioSelector] Ningún municipio disponible para este deployment:",
      deployment
    );
    return;
  }

  // ── Municipio único: carga automática, sin selector en el DOM ────────────
  // Con un solo municipio configurado el selector no aporta valor al usuario
  // final: no hay nada que elegir. El contenedor queda vacío intencionalmente
  // para no romper el layout del slot content-center de calcite-navigation.
  // La carga se dispara aquí directamente, sin esperar interacción.
  // _municipioActivo como guardia evita doble carga si idioma-cambiado
  // vuelve a invocar renderMunicipioSelector con el mismo municipio.
  if (municipiosVisibles.length === 1) {
    const unicoCodigo = municipiosVisibles[0].codigo_ine;
    if (_municipioActivo !== unicoCodigo) {
      _cargarMunicipio(unicoCodigo);
    }
    return; // ← sale sin construir ningún elemento DOM
  }

  // ── Varios municipios: construir el selector Calcite ─────────────────────
  // A partir de aquí el código es idéntico al actual, sin cambios.

  const label = document.createElement("calcite-label");
  label.setAttribute("layout", "inline");
  label.textContent = t("nav.municipio.label"); // no hardcoded

  const select = document.createElement("calcite-select");
  select.id = "municipio-select";
  select.setAttribute("label", t("nav.municipio.placeholder")); // no hardcoded

  // La opción vacía solo tiene sentido cuando hay más de un municipio.
  // Con un único municipio se carga automáticamente y el placeholder no aporta.
  if (municipiosVisibles.length > 1) {
    const defaultOpt = document.createElement("calcite-option");
    defaultOpt.value       = "";
    defaultOpt.textContent = t("nav.municipio.placeholder"); // no hardcoded
    select.appendChild(defaultOpt);
  }

  municipiosVisibles.forEach(m => {
    const opt = document.createElement("calcite-option");
    opt.value       = m.codigo_ine;
    // Nota: se corrige aquí un bug preexistente — el campo usado era
    // "provincia_nombre", que no existe en el schema de municipios.json
    // (solo provincia_code). Mostraba literalmente "(undefined)".
    opt.textContent = `${m.nombre} (${m.provincia_code})`;
    select.appendChild(opt);
  });

  if (_municipioActivo) {
    select.value = _municipioActivo;
  }

  select.addEventListener("calciteSelectChange", _onMunicipioChange);

  label.appendChild(select);
  el.appendChild(label);


}

// ─── Handlers privados ────────────────────────────────────────────────────────

/**
 * Handler del evento calciteSelectChange.
 * Delega en _cargarMunicipio para mantener DRY con la carga automática.
 */
async function _onMunicipioChange(event) {
  await _cargarMunicipio(event.target.value);
}

/**
 * Pipeline de carga de un municipio.
 *
 * Extraído del handler para ser reutilizable desde la carga automática
 * sin duplicar lógica (DRY). Ambas rutas (evento + automática) convergen aquí.
 *
 * @param {string} codigoIne - Código INE del municipio a cargar
 */
async function _cargarMunicipio(codigoIne) {
  // Sin selección real o pipeline ya en curso → ignorar
  if (!codigoIne || _cargando) return;

  const municipioData = _municipiosDisponibles.find(m => m.codigo_ine === codigoIne);
  if (!municipioData) return;

  _municipioActivo = codigoIne;

  _cargando = true;
  _setLoading(true);

  try {
    console.info(`[municipioSelector] → ${municipioData.nombre} (${municipioData.codigo_ine})`);

    emit("municipio-seleccionado", { municipioData });

    // ── 1. Resolver capas del catálogo para este municipio ──
    const configs = await configEngine.fetchCapas(municipioData);

    if (configs.length === 0) {
      console.warn(`[municipioSelector] No hay capas disponibles para "${municipioData.nombre}"`);
      return;
    }

    // ── 2. Crear instancias Esri en paralelo ──
    const layersConNull = await Promise.all(
      configs.map(config => crearCapa(config))
    );

    // Emparejar config + layer y filtrar las que fallaron (null)
    const pares = configs
      .map((config, i) => ({ config, layer: layersConNull[i] }))
      .filter(({ layer }) => layer !== null);

    if (pares.length === 0) {
      console.error("[municipioSelector] Ninguna capa pudo ser creada.");
      return;
    }

    // ── 3. Aplicar filtros runtime (BBOX, FILTRABLE, DIRECTA...) ──
    await Promise.all(
      pares.map(({ layer, config }) => inicializarCapa(layer, config, municipioData))
    );

    const layers  = pares.map(p => p.layer);
    const cfgList = pares.map(p => p.config);

    // ── 4. Añadir capas al mapa ──
    // WFSLayer descarga features en map.add() aunque visible=false.
    // Las WFS no entran al mapa hasta que el usuario las active desde
    // el árbol de capas (lazy-load implementado en layerTree.js).
    const capasInmediatas = layers.filter((_, i) => cfgList[i].tipo !== "WFS");
    mapManager.addCapas(capasInmediatas);

    // ── 5. Actualizar máscara visual (recorte WMS por polígono municipal) ──
    await mapManager.actualizarMascara(municipioData.polygon);

    // ── 6. Zoom al municipio ──
    await mapManager.irAlMunicipio(municipioData.bbox);

    // ── 7. Notificar: layerTree y legendPanel reaccionarán ──
    emit("municipio-cargado", {
      municipioData,
      layers,
      configs: cfgList,
      lazyLayerIds: new Set(
        cfgList.filter(c => c.tipo === "WFS").map(c => c.id)
      )
    });

    console.info(
      `[municipioSelector] ✓ ${layers.length} capas cargadas para "${municipioData.nombre}"`
    );

  } catch (err) {
    console.error("[municipioSelector] Error durante la carga del municipio:", err);
  } finally {
    _cargando = false;
    _setLoading(false);
  }
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

/** Muestra u oculta el spinner de carga del select Calcite */
function _setLoading(isLoading) {
  const select = document.getElementById("municipio-select");
  if (!select) return;
  isLoading
    ? select.setAttribute("loading", "")
    : select.removeAttribute("loading");
}

function _registrarListenerIdioma() {
  if (_idiomaListenerRegistrado) return;
  _idiomaListenerRegistrado = true;

  on("idioma-cambiado", () => {
    if (_containerEl) {
      renderMunicipioSelector(_containerEl, _municipiosDisponibles, _deploymentRef);
    }
  });
}