/**
 * ui/municipioSelector.js
 *
 * Selector de municipio. Punto de entrada del flujo de carga de datos.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Renderizar un selector Calcite y, al elegir un municipio, orquestar
 * el pipeline completo de carga:
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
 */

import { MUNICIPIOS }            from "../config/municipios.js";
import * as configEngine         from "../config/configEngine.js";
import * as mapManager           from "../core/mapManager.js";
import { crearCapa }             from "../core/layerFactory.js";
import { inicializarCapa }       from "../core/layerInitializer.js";
import { emit }                  from "../utils/eventBus.js";

// Semáforo: evitar doble carga si el usuario cambia de municipio rápidamente
let _cargando = false;

/**
 * Renderiza el selector de municipio en el contenedor indicado.
 * @param {HTMLElement|string} container - Elemento DOM o selector CSS
 */
export function renderMunicipioSelector(container) {
  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    console.error("[municipioSelector] Contenedor no encontrado:", container);
    return;
  }

  // ── Etiqueta ──
  const label = document.createElement("calcite-label");
  label.setAttribute("layout", "inline");
  label.textContent = "Municipio: ";

  // ── Select Calcite ──
  const select = document.createElement("calcite-select");
  select.id    = "municipio-select";
  select.setAttribute("label", "Selecciona un municipio");

  // Opción vacía por defecto
  const defaultOpt = document.createElement("calcite-option");
  defaultOpt.value       = "";
  defaultOpt.textContent = "— Selecciona un municipio —";
  select.appendChild(defaultOpt);

  // Una opción por cada municipio disponible
  MUNICIPIOS.forEach(m => {
    const opt = document.createElement("calcite-option");
    opt.value       = m.codigo_ine;
    opt.textContent = `${m.nombre} (${m.provincia_nombre})`;
    select.appendChild(opt);
  });

  select.addEventListener("calciteSelectChange", _onMunicipioChange);

  label.appendChild(select);
  el.appendChild(label);
}

// ─── Handler privado ──────────────────────────────────────────────────────

async function _onMunicipioChange(event) {
  const codigoIne = event.target.value;

  // Sin selección real o pipeline ya en curso → ignorar
  if (!codigoIne || _cargando) return;

  const municipioData = MUNICIPIOS.find(m => m.codigo_ine === codigoIne);
  if (!municipioData) return;

  _cargando = true;
  _setLoading(true);

  try {
    console.info(`[municipioSelector] → ${municipioData.nombre} (${municipioData.codigo_ine})`);

    // Notificar a otros módulos que empieza la carga (si necesitan mostrar spinner)
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
    // Las WFS se registran pero no entran al mapa hasta que el usuario
    // las active desde el árbol (lazy-load en layerTree.js).
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

// Muestra/oculta el indicador de carga en el select
function _setLoading(isLoading) {
  const select = document.getElementById("municipio-select");
  if (!select) return;
  isLoading
    ? select.setAttribute("loading", "")
    : select.removeAttribute("loading");
}