/**
 * ui/municipioSelector.js
 *
 * Selector de municipio. Punto de entrada del flujo de carga de datos.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Renderizar un selector Calcite y orquestar el pipeline de carga de datos,
 * ahora en DOS MODELOS distintos según el ámbito del deployment:
 *
 *   Modelo A — ambitoTerritorial: "municipio" (sin cambios de comportamiento)
 *     Un único pipeline: elegir municipio → RECONSTRUYE todo el conjunto
 *     de capas desde cero. Usado por ayuntamiento único y comarca curada.
 *     Función: _cargarMunicipio() (privada, sin cambios).
 *
 *   Modelo B — ambitoTerritorial: "provincia" | "ccaa" (NUEVO)
 *     Carga incremental en dos capas:
 *       1. cargarAmbitoTerritorial(territorioData) — UNA VEZ al arrancar.
 *          Resuelve y añade las capas de cobertura territorial (nacional/
 *          europea/global/autonómica/provincial). Aplica máscara y zoom
 *          sobre el territorio completo.
 *       2. agregarCapasMunicipio(codigoIne) — al elegir un municipio.
 *          SUMA (no reemplaza) las capas de cobertura "municipal" que
 *          apliquen a ese municipio. La base territorial permanece intacta.
 *       3. retirarCapasMunicipio() — al limpiar la selección.
 *          Inverso exacto de (2): retira solo lo añadido, vuelve a la
 *          máscara/zoom territorial.
 *
 * ── POR QUÉ DOS MODELOS Y NO UNO SOLO ─────────────────────────────────────
 * El modelo A siempre tuvo sentido: sin territorio superior, "elegir
 * municipio" ES la única fuente de verdad de qué mostrar — no hay nada
 * que preservar entre selecciones. El modelo B nace porque a nivel
 * provincia/ccaa SÍ existe una base que no debe destruirse cada vez que
 * el usuario prueba un municipio distinto (ver 3DECISIONS.md — hilo de
 * ámbito territorial). Forzar el modelo A en ambos casos convertiría cada
 * cambio de municipio en un cliente Diputación/Gobierno regional en una
 * recarga completa de capas ya cargadas — desperdicio de red y de estado
 * (WMS ya cargado, WFS con features en memoria) sin ninguna necesidad.
 *
 * ── LO QUE NO HACE ───────────────────────────────────────────────────────
 * No instancia capas directamente (delegado a layerFactory).
 * No construye el árbol DOM de capas (delegado a layerTree).
 * No conoce el formato de las capas Esri.
 * No decide qué municipios son visibles (delegado a territorioResolver).
 */

import * as configEngine          from "../config/configEngine.js";
import * as mapManager            from "../core/mapManager.js";
import { crearCapa }              from "../core/layerFactory.js";
import { inicializarCapa }        from "../core/layerInitializer.js";
import { emit, on }               from "../utils/eventBus.js";
import { clearContainer }         from "../utils/domUtils.js";
import { t }                      from "../config/i18n/i18nManager.js";

// ─── Estado interno del módulo ─────────────────────────────────────────────

let _cargando               = false;
let _municipioActivo        = null;   // codigo_ine del municipio elegido, o null
let _containerEl            = null;
let _deploymentRef          = { municipios: [] };
let _municipiosDisponibles  = [];     // resuelto por territorioResolver
let _idiomaListenerRegistrado = false;

// Estado nuevo — solo relevante en Modelo B (ambitoTerritorial provincia/ccaa).
// Se guarda aquí porque main.js lo descarta tras la carga inicial, y
// retirarCapasMunicipio() lo necesita para volver a la máscara/zoom
// territorial sin tener que llamar de nuevo a territorioResolver.
let _territorioData         = null;
// IDs de las capas municipales actualmente añadidas — necesario para que
// retirarCapasMunicipio() sepa exactamente qué quitar del mapa y del árbol
// sin afectar la base territorial.
let _capasMunicipioActivas  = [];

export function getMunicipioActivo() {
  return _municipioActivo;
}

/**
 * API pública para cargar un municipio por código INE desde fuera del módulo.
 * Usada por main.js para restaurar el estado tras un cambio de idioma.
 * Delega en _cargarMunicipio para mantener DRY — un único pipeline.
 * Solo aplica al Modelo A (ambitoTerritorial "municipio").
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
  const esAmbitoTerritorial = (deployment.ambitoTerritorial ?? "municipio") !== "municipio";

  if (municipiosVisibles.length === 0) {
    console.warn(
      "[municipioSelector] Ningún municipio disponible para este deployment:",
      deployment
    );
    return;
  }

  // ── Municipio único: carga automática, sin selector en el DOM ────────────
  // Solo aplica al Modelo A. En Modelo B (provincia/ccaa) SIEMPRE se muestra
  // el selector, incluso si el territorio de prueba solo tiene 1 municipio
  // en el dataset actual — el usuario elige explícitamente, no hay carga
  // automática de un municipio dentro de un territorio.
  if (municipiosVisibles.length === 1 && !esAmbitoTerritorial) {
    const unicoCodigo = municipiosVisibles[0].codigo_ine;
    if (_municipioActivo !== unicoCodigo) {
      _cargarMunicipio(unicoCodigo);
    }
    return; // ← sale sin construir ningún elemento DOM
  }

  // ── Selector Calcite ───────────────────────────────────────────────────

  const label = document.createElement("calcite-label");
  label.setAttribute("layout", "inline");
  label.textContent = t("nav.municipio.label");

  const select = document.createElement("calcite-select");
  select.id = "municipio-select";
  select.setAttribute("label", t("nav.municipio.placeholder"));

  const defaultOpt = document.createElement("calcite-option");
  defaultOpt.value       = "";
  defaultOpt.textContent = t("nav.municipio.placeholder");
  select.appendChild(defaultOpt);

  municipiosVisibles.forEach(m => {
    const opt = document.createElement("calcite-option");
    opt.value       = m.codigo_ine;
    opt.textContent = `${m.nombre} (${m.provincia_code})`;
    select.appendChild(opt);
  });

  if (_municipioActivo) {
    select.value = _municipioActivo;
  }

  // El handler de cambio se bifurca según el modelo — ver _onMunicipioChange.
  select.addEventListener("calciteSelectChange", _onMunicipioChange);

  label.appendChild(select);
  el.appendChild(label);
}

// ─── Handlers privados ─────────────────────────────────────────────────────

/**
 * Handler del evento calciteSelectChange.
 * Se bifurca según el ámbito del deployment activo:
 *   - "municipio" → _cargarMunicipio() (Modelo A, comportamiento existente)
 *   - "provincia"/"ccaa" → agregarCapasMunicipio() / retirarCapasMunicipio()
 *     (Modelo B, incremental). Valor vacío ("") = el usuario limpió la
 *     selección → retirar.
 *
 * Nota: con <calcite-select> la única forma de "limpiar" es elegir la
 * opción vacía inicial. El comportamiento de "X" pensado para
 * calcite-combobox (pendiente en 4STATUS.md) llamará a la misma
 * retirarCapasMunicipio() cuando se migre el componente — este handler
 * ya queda preparado para ese reemplazo sin cambios adicionales aquí.
 */
async function _onMunicipioChange(event) {
  const codigoIne = event.target.value;
  const esAmbitoTerritorial = (_deploymentRef.ambitoTerritorial ?? "municipio") !== "municipio";

  if (!esAmbitoTerritorial) {
    await _cargarMunicipio(codigoIne);
    return;
  }

  if (!codigoIne) {
    await retirarCapasMunicipio();
  } else {
    await agregarCapasMunicipio(codigoIne);
  }
}

/**
 * Pipeline de carga de un municipio — MODELO A (ambitoTerritorial "municipio").
 * Reconstruye por completo el conjunto de capas. Sin cambios de
 * comportamiento respecto a la versión anterior.
 *
 * @param {string} codigoIne - Código INE del municipio a cargar
 */
async function _cargarMunicipio(codigoIne) {
  if (!codigoIne || _cargando) return;

  const municipioData = _municipiosDisponibles.find(m => m.codigo_ine === codigoIne);
  if (!municipioData) return;

  _municipioActivo = codigoIne;

  _cargando = true;
  _setLoading(true);

  try {
    console.info(`[municipioSelector] → ${municipioData.nombre} (${municipioData.codigo_ine})`);

    emit("municipio-seleccionado", { municipioData });

    const configs = await configEngine.fetchCapas(municipioData);

    if (configs.length === 0) {
      console.warn(`[municipioSelector] No hay capas disponibles para "${municipioData.nombre}"`);
      return;
    }

    const layersConNull = await Promise.all(
      configs.map(config => crearCapa(config))
    );

    const pares = configs
      .map((config, i) => ({ config, layer: layersConNull[i] }))
      .filter(({ layer }) => layer !== null);

    if (pares.length === 0) {
      console.error("[municipioSelector] Ninguna capa pudo ser creada.");
      return;
    }

    await Promise.all(
      pares.map(({ layer, config }) => inicializarCapa(layer, config, municipioData))
    );

    const layers  = pares.map(p => p.layer);
    const cfgList = pares.map(p => p.config);

    const capasInmediatas = layers.filter((_, i) => cfgList[i].tipo !== "WFS");
    mapManager.addCapas(capasInmediatas);

    await mapManager.actualizarMascara(municipioData.polygon);
    await mapManager.irAlMunicipio(municipioData.bbox);

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

// ─── Pipeline MODELO B — ámbito territorial (provincia/ccaa) ──────────────

/**
 * Carga la BASE territorial — capas de cobertura nacional/europea/global/
 * autonómica/provincial. Se ejecuta UNA VEZ al arrancar, cuando
 * deployment.ambitoTerritorial !== "municipio".
 *
 * Usa mapManager.addCapas() (reemplaza) porque en este punto el mapa
 * todavía no tiene ninguna capa de datos — es la primera carga, no hay
 * nada que preservar. addCapa() incremental entra en juego después,
 * en agregarCapasMunicipio().
 *
 * @param {Object} territorioData - { bbox, polygon, provincia_code,
 *   ccaa_code, codigo_ine: null }, viene de territorioResolver.mascaraInicial
 */
export async function cargarAmbitoTerritorial(territorioData) {
  if (_cargando) return;
  _cargando = true;
  _setLoading(true);

  try {
    _territorioData = territorioData; // guardado para retirarCapasMunicipio()

    console.info("[municipioSelector] → Cargando ámbito territorial base");

    const configs = await configEngine.fetchCapasTerritoriales(territorioData);

    if (configs.length === 0) {
      console.warn("[municipioSelector] Sin capas territoriales para este ámbito");
      return;
    }

    const layersConNull = await Promise.all(
      configs.map(config => crearCapa(config))
    );

    const pares = configs
      .map((config, i) => ({ config, layer: layersConNull[i] }))
      .filter(({ layer }) => layer !== null);

    await Promise.all(
      pares.map(({ layer, config }) => inicializarCapa(layer, config, territorioData))
    );

    const layers  = pares.map(p => p.layer);
    const cfgList = pares.map(p => p.config);

    const capasInmediatas = layers.filter((_, i) => cfgList[i].tipo !== "WFS");
    mapManager.addCapas(capasInmediatas); // primera carga → reemplazo seguro, no hay nada que preservar aún

    await mapManager.actualizarMascara(territorioData.polygon);
    await mapManager.irAlMunicipio(territorioData.bbox);

    emit("territorio-cargado", {
      territorioData,
      layers,
      configs: cfgList,
      lazyLayerIds: new Set(
        cfgList.filter(c => c.tipo === "WFS").map(c => c.id)
      )
    });

    console.info(`[municipioSelector] ✓ ${layers.length} capas territoriales base cargadas`);

  } catch (err) {
    console.error("[municipioSelector] Error al cargar ámbito territorial:", err);
  } finally {
    _cargando = false;
    _setLoading(false);
  }
}

/**
 * SUMA las capas de cobertura "municipal" de un municipio concreto a la
 * base territorial ya cargada. No reconstruye nada — usa mapManager.addCapa()
 * (singular) capa por capa para no pisar lo que ya está en el mapa.
 *
 * Si había un municipio distinto ya agregado, primero se retira (un
 * territorio solo tiene un municipio "en foco" a la vez, aunque la base
 * territorial sea compartida).
 *
 * @param {string} codigoIne
 */
export async function agregarCapasMunicipio(codigoIne) {
  if (!codigoIne || _cargando) return;

  const municipioData = _municipiosDisponibles.find(m => m.codigo_ine === codigoIne);
  if (!municipioData) return;

  // Cambiar de municipio dentro del mismo territorio: retirar el anterior
  // antes de añadir el nuevo, para no acumular capas municipales de dos
  // municipios distintos a la vez.
  if (_municipioActivo && _municipioActivo !== codigoIne) {
    await retirarCapasMunicipio({ mantenerZoomTerritorial: true });
  }

  _municipioActivo = codigoIne;
  _cargando = true;
  _setLoading(true);

  try {
    console.info(`[municipioSelector] + Agregando capas municipales: ${municipioData.nombre}`);

    emit("municipio-seleccionado", { municipioData });

    const configs = await configEngine.fetchCapasMunicipales(municipioData);

    if (configs.length === 0) {
      console.info(`[municipioSelector] "${municipioData.nombre}" no tiene capas municipales propias`);
      // Aun sin capas nuevas, el zoom al municipio sigue teniendo sentido
      // para el usuario — se hace zoom pero no se emite capas-municipio-agregadas
      // vacío (evita que layerTree procese un array sin contenido).
      await mapManager.irAlMunicipio(municipioData.bbox);
      return;
    }

    const layersConNull = await Promise.all(
      configs.map(config => crearCapa(config))
    );

    const pares = configs
      .map((config, i) => ({ config, layer: layersConNull[i] }))
      .filter(({ layer }) => layer !== null);

    await Promise.all(
      pares.map(({ layer, config }) => inicializarCapa(layer, config, municipioData))
    );

    const layers  = pares.map(p => p.layer);
    const cfgList = pares.map(p => p.config);

    // ── Diferencia clave con _cargarMunicipio: addCapa() singular, en bucle ──
    // addCapas() (plural) reemplazaría toda la base territorial. addCapa()
    // (singular) solo añade — mismo mecanismo ya usado por layerTree para
    // el lazy-load de WFS, aquí aplicado a la carga inicial de capas
    // municipales no-WFS.
    layers.forEach((layer, i) => {
      if (cfgList[i].tipo !== "WFS") {
        mapManager.addCapa(layer);
      }
    });

    // No se toca la máscara territorial (actualizarMascara) — la base
    // sigue siendo el territorio completo. Solo se hace zoom al municipio
    // para que el usuario vea el detalle, sin perder el contexto visual
    // territorial de fondo.
    await mapManager.irAlMunicipio(municipioData.bbox);

    _capasMunicipioActivas = cfgList.map(c => c.id);

    emit("capas-municipio-agregadas", {
      municipioData,
      layers,
      configs: cfgList,
      lazyLayerIds: new Set(
        cfgList.filter(c => c.tipo === "WFS").map(c => c.id)
      )
    });

    console.info(
      `[municipioSelector] ✓ ${layers.length} capas municipales agregadas para "${municipioData.nombre}"`
    );

  } catch (err) {
    console.error("[municipioSelector] Error al agregar capas municipales:", err);
  } finally {
    _cargando = false;
    _setLoading(false);
  }
}

/**
 * Retira las capas municipales agregadas por agregarCapasMunicipio() y
 * devuelve la vista al estado de base territorial (máscara + zoom).
 * Inverso exacto de agregarCapasMunicipio() — no toca la base territorial.
 *
 * @param {Object} [opciones]
 * @param {boolean} [opciones.mantenerZoomTerritorial=false] - Si true, no
 *   hace zoom de vuelta al territorio (usado internamente por
 *   agregarCapasMunicipio() al cambiar de un municipio a otro, donde el
 *   siguiente zoom lo hará la propia función que llama).
 */
export async function retirarCapasMunicipio({ mantenerZoomTerritorial = false } = {}) {
  if (_capasMunicipioActivas.length === 0 && !_municipioActivo) return;

  const map = mapManager.getMap();
  const idsARetirar = [..._capasMunicipioActivas];

  if (map) {
    const capasARemover = map.layers
      .filter(l => idsARetirar.includes(l.id))
      .toArray();
    map.layers.removeMany(capasARemover);
  }

  emit("capas-municipio-retiradas", { layerIds: idsARetirar });

  _capasMunicipioActivas = [];
  _municipioActivo = null;

  if (!mantenerZoomTerritorial && _territorioData) {
    await mapManager.actualizarMascara(_territorioData.polygon);
    await mapManager.irAlMunicipio(_territorioData.bbox);
  }

  // Sincronizar el <calcite-select> de vuelta a la opción vacía, por si
  // la llamada vino de un origen distinto al propio change del selector
  // (ej. futuro botón "X" del combobox).
  const select = document.getElementById("municipio-select");
  if (select) select.value = "";

  console.info(`[municipioSelector] − ${idsARetirar.length} capas municipales retiradas`);
}

// ─── Helpers privados ─────────────────────────────────────────────────────

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