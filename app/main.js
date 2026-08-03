/**
 * main.js
 *
 * Punto de entrada y orquestador de la aplicación GIS Municipal.
 *
 * ── RESPONSABILIDAD ÚNICA ────────────────────────────────────────────────
 * Arrancar la app en el orden correcto:
 *   1. Registrar el adaptador de datos (Repository Pattern)
 *   2. Inicializar el mapa
 *   3. Resolver el ámbito territorial del deployment (municipio/provincia/ccaa)
 *   4. Montar los módulos de UI
 * Sin lógica propia. Todo está delegado a los módulos especializados.
 *
 * ── LA ÚNICA DECISIÓN QUE TOMA main.js ───────────────────────────────────
 * Qué adaptador usar. Para cambiar de fuente de datos solo hay que cambiar
 * esta línea:
 *   setAdaptador(new LocalJsonAdapter(...))
 *    →  setAdaptador(new RestApiAdapter("https://api.ejemplo.com/capas"))
 *    →  setAdaptador(new PostGISAdapter(config))
 * Ningún otro archivo cambia.
 *
 * ── AJUSTE (soporte de ámbito territorial) ────────────────────────────────
 * El paso 4.5 antes solo aplicaba la máscara visual del territorio
 * (actualizarMascara + irAlMunicipio), sin cargar ninguna capa — el árbol
 * quedaba vacío hasta que el usuario elegía un municipio. Ahora, cuando
 * ambitoTerritorial !== "municipio", el paso 4.5 llama a
 * municipioSelector.cargarAmbitoTerritorial(territorioData), que resuelve
 * y añade las capas de cobertura territorial (nacional/europea/global/
 * autonómica/provincial) además de aplicar máscara y zoom — mismo pipeline
 * completo que ya existía para un municipio individual, pero a escala
 * territorial. Ver 3DECISIONS.md, hilo "ámbito territorial: soporte
 * provincia/ccaa" y ui/municipioSelector.js para el detalle del modelo
 * incremental (base territorial + capas municipales sumadas después).
 */

// ── Config ──────────────────────────────────────────────────────────────
import { LocalJsonAdapter }        from "../config/adapters/LocalJsonAdapter.js";
import { setAdaptador }            from "../config/configEngine.js"; // le dice al sistema qué fuente de datos usar
import { resolverAmbitoTerritorial } from "../config/territorioResolver.js";
import { DEPLOYMENT }              from "../config/deployment.js";


// ── Core ─────────────────────────────────────────────────────────────────
// Main no crea el mapa directamente, lo inicializa 
import * as mapManager from "../core/mapManager.js";


// ── Lang ─────────────────────────────────────────────────────────────────
import { init as initI18n } from "../config/i18n/i18nManager.js";

// ── UI ────────────────────────────────────────────────────────────────────
// Cada función importada monta una parte visual
import { initActionBar } from "../ui/actionBar.js";
import { renderMunicipioSelector, cargarAmbitoTerritorial } from "../ui/municipioSelector.js";
import { renderBasemapSelector }   from "../ui/basemapSelector.js";
import { initLayerTree }           from "../ui/layerTree.js";
import { initLegendPanel }         from "../ui/legendPanel.js";
import { initHeaderControls }      from "../ui/headerControls.js";
import * as eventBus from '../utils/eventBus.js';
import { initMapControls } from "../ui/mapControls.js";
import { initToolPanel } from "../ui/toolPanel.js";





// ─── Bootstrap ────────────────────────────────────────────────────────────

/**
 * Espera a que el SDK de ArcGIS esté disponible (window.$arcgis).
 *
 * POR QUÉ es necesario:
 * Aunque el SDK se carga con type="module" (lo que garantiza que su script
 * termina antes de que main.js ejecute), el SDK puede hacer dynamic imports
 * internos asincrónicos para registrar $arcgis. En ese caso $arcgis todavía
 * no está disponible al inicio de main().
 *
 * Este guard sondea cada 50ms hasta 5 segundos. En condiciones normales
 * resuelve en el primer o segundo intento (<100ms). Si supera el timeout,
 * lanza un error descriptivo en lugar del críptico "is not defined".
 *
 * @param {number} maxWaitMs
 * @returns {Promise<void>}
 */

// ── CARGA DE $ARCGIS ────────────────────────────────────────────────────────────────────
async function waitForArcGISSDK(maxWaitMs = 5000) {
  if (window.$arcgis) return; // Comprueba si ya está disponible y sale inmediatamente

  // si $arcgis no existe, empieza un intervalo, cada 50 ms revisa if (window.$arcgis)
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {  
      if (window.$arcgis) {
        clearInterval(interval);
        resolve(); // cuando $arcgis aparece detiene el polling y resuelve la promesa
      } else if (Date.now() - start > maxWaitMs) { // evita esperar infinitamente, después de 5segundos muestra el error
        clearInterval(interval);
        reject(new Error(
          "ArcGIS SDK no disponible tras 5s. " +
          "Verifica que el <script type=\"module\" src=\"https://js.arcgis.com/5.0/\"> " +
          "está en el <head> antes de main.js."
        ));
      }
    }, 50);
  });
}

// ── Branding ────────────────────────────────────────────────────────────
// Aplica la identidad visual de la instancia desde deployment.js.
// Se ejecuta antes que cualquier otro módulo para que el logo sea
// lo primero que el usuario vea al cargar, sin flash de contenido sin marca.
function aplicarBranding(branding) {
  if (!branding) return;

  const navLogo = document.querySelector("calcite-navigation-logo");
  if (!navLogo) return;

  // Nombre y descripción — sobreescriben los valores por defecto del HTML
  if (branding.nombre_visible) navLogo.setAttribute("heading",     branding.nombre_visible);
  if (branding.descripcion)    navLogo.setAttribute("description", branding.descripcion);

  // Logo del cliente — si existe, reemplaza el icono SVG por una imagen real
  if (branding.logo_cliente) {
    navLogo.setAttribute("thumbnail", branding.logo_cliente);
    navLogo.removeAttribute("icon");   // icon y thumbnail son mutuamente excluyentes en Calcite
  }

  // Logo de empresa — se inyecta como elemento fijo en el extremo derecho del header
  // y comparte alineación con el selector de idioma en content-end.
  if (branding.logo_empresa) {
    _inyectarLogoEmpresa(branding.logo_empresa);  
  }
}

function _inyectarLogoEmpresa(src) {
  // El logo de la empresa va fijo en el extremo derecho del header,
  // después del selector de idioma, para que ambos queden alineados sin solaparse.
  const existing = document.getElementById("logo-empresa-container");
  if (existing) return; // idempotente — no duplicar si se llama dos veces

  const wrapper = document.createElement("div");
  wrapper.id = "logo-empresa-container";
  wrapper.className = "logo-empresa";

  const img = document.createElement("img");
  img.src = src;
  img.alt = "Bilbomática";
  img.className = "logo-empresa-img";

  // Fallback silencioso: si la imagen no carga, el contenedor desaparece
  img.onerror = () => { wrapper.style.display = "none"; };

  wrapper.appendChild(img);

  // Se inserta en el slot content-end de calcite-navigation,
  // después del selector de idioma para mantener el orden visual.
  const nav = document.querySelector("calcite-navigation");
  if (nav) {
    wrapper.setAttribute("slot", "content-end");
    nav.appendChild(wrapper);
  }
}

// ── Logo por-municipio (runtime) ──────────────────────────────────────────
// Prueba en cascada qué extensión existe realmente para un codigo_ine,
// en vez de mantener una tabla editorial a mano dentro del código (ver
// 3DECISIONS.md, 30.07.26 — logo desacoplado de generar_geografia.py).

const _LOGO_EXTENSIONES = ["webp", "jpg", "jpeg", "png", "svg"];

/**
 * Prueba si una imagen carga realmente en el navegador (existe en el
 * servidor), sin asumir nada de antemano.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function _probarImagen(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/**
 * Resuelve la URL del logo de un municipio probando extensiones en orden.
 * Devuelve null si no existe ningún archivo de logo para ese codigo_ine
 * (caso normal para la mayoría de municipios — no todos tienen logo subido).
 * @param {string} codigoIne
 * @returns {Promise<string|null>}
 */
async function _resolverLogoMunicipio(codigoIne) {
  for (const ext of _LOGO_EXTENSIONES) {
    const url = `../assets/logos/${codigoIne}.${ext}`;
    if (await _probarImagen(url)) return url;
  }
  return null;
}

// ── ARRANQUE ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.info("=== GIS Municipal — Arrancando... ===");


    // 0. Aplicar branding de la instancia antes de montar cualquier UI
    aplicarBranding(DEPLOYMENT.branding);
    // 1. Esperar SDK — bug corregido: la función existía pero no se llamaba
    await waitForArcGISSDK();

    // 2. Inicializar i18n ANTES de montar UI
    //    Carga el JSON del idioma activo y aplica data-i18n al DOM
    await initI18n();

    // 3. Registrar adaptador de datos antes de cualquier operación de catálogo
    setAdaptador(new LocalJsonAdapter("../data/catalogo-capas.json"));

    // 4. Inicializar el Map único con sus dos vistas (2D y 3D)
    await mapManager.initMap({
      mapContainerId:   "map-view",
      sceneContainerId: "scene-view"
    });

    // 4.5. Resolver ámbito territorial del deployment activo (solo resuelve
    // datos, NO carga capas todavía — cargarAmbitoTerritorial() se llama
    // después de montar la UI, ver nota más abajo).
    const { municipiosDisponibles, mascaraInicial } = await resolverAmbitoTerritorial(DEPLOYMENT);

    // 5. Montar UI
    // ── AJUSTE CRÍTICO DE ORDEN ────────────────────────────────────────────
    // initLayerTree() debe montarse ANTES de cargarAmbitoTerritorial(), porque
    // esa función emite "territorio-cargado" de forma síncrona al terminar.
    // eventBus no tiene buffer de eventos (pub/sub puro, ver utils/eventBus.js):
    // un evento emitido sin listeners suscritos se pierde sin aviso. Con
    // "municipio-cargado" nunca fue un problema porque solo se dispara tras
    // interacción del usuario, cuando la UI ya lleva rato montada. Con
    // "territorio-cargado" el disparo ocurre durante el arranque — antes de
    // este ajuste, el árbol de capas se quedaba vacío en silencio (sin error
    // en consola) porque el evento llegaba a un módulo que aún no existía.
    initActionBar();
    initMapControls();
    renderMunicipioSelector("#municipio-selector-container", municipiosDisponibles, DEPLOYMENT);
    renderBasemapSelector("#basemap-selector-container");
    initLayerTree("#layer-tree-container");   // ← debe ir antes de cargarAmbitoTerritorial()
    initLegendPanel("map-view");
    await initToolPanel(DEPLOYMENT.herramientas);
    initHeaderControls(document.getElementById("lang-selector-container"));

    // 5.5. Ahora sí: cargar la base territorial, con layerTree ya escuchando.
    if (mascaraInicial) {
      await cargarAmbitoTerritorial(mascaraInicial);
    }
    // ── Logo por-municipio en el header (runtime, 30.07.26) ──────────────────
    // Reemplaza el listener anterior que leía municipioData.logo — ese campo
    // ya no existe en municipios.json desde que se desacopló geometría de
    // presentación (ver 3DECISIONS.md). En su lugar, se prueba en cascada
    // qué extensión de imagen existe realmente en assets/logos/ para el
    // codigo_ine del municipio activo. Sin lista hardcodeada de excepciones:
    // el navegador confirma qué archivo existe, no un mapa editorial a mano.
    //
    // Solo aplica al modelo "municipio" (deployment sin ambitoTerritorial,
    // ej. demo). Cuando el deployment tiene ambitoTerritorial ("provincia"/
    // "ccaa", ej. bizkaia, navarra), el logo del header representa a la
    // entidad territorial (Diputación, Gobierno regional) y debe permanecer
    // fijo — buscar un municipio dentro del territorio no debe pisar ese
    // branding con el logo (si existiera) del municipio elegido.
    //
    // Nota (ajuste ámbito territorial): este listener sigue enganchado a
    // "municipio-cargado" únicamente — no a "capas-municipio-agregadas".
    // Es intencional: _permiteLogoPorMunicipio ya es false para cualquier
    // deployment con ambitoTerritorial, así que el guard hace que este
    // bloque nunca actúe en el Modelo B de todas formas. Si en el futuro
    // se decide sí actualizar el logo al elegir municipio dentro de un
    // territorio, este es el punto a extender — no antes.
    const _permiteLogoPorMunicipio = !DEPLOYMENT.ambitoTerritorial;

    eventBus.on("municipio-cargado", async ({ municipioData }) => {
      if (!_permiteLogoPorMunicipio) return; // ámbito territorial: branding fijo, no se toca

      const navLogo = document.querySelector("calcite-navigation-logo");
      if (!navLogo) return;

      const logoUrl = await _resolverLogoMunicipio(municipioData.codigo_ine);

      navLogo.setAttribute("heading", municipioData.nombre);
      if (logoUrl) {
        navLogo.setAttribute("thumbnail", logoUrl);
        navLogo.removeAttribute("icon"); // Calcite requiere quitar el icono para mostrar el thumbnail
      }
      // Si no se encontró ningún logo, se deja el icono/thumbnail que ya
      // hubiera (por ejemplo el de deployment.branding) — no se fuerza nada.
    });

    console.info("=== GIS Municipal — Listo ===");

  // SI TODO FALLA
  } catch (err) {

    //error en consola
    console.error("[main] Error fatal al inicializar:", err); // error en consola

    // muestra error al usuario en el navegador
    const errEl = document.getElementById("app-error"); // conecta con index
    if (errEl) {
      errEl.textContent = `Error al inicializar: ${err.message}`;
      errEl.classList.remove("hidden");
    }
  }
}

// Garantizar que el DOM está listo antes de acceder a los elementos
// el evento garantiza que el Index HTML este completamente parseado 
// los elementos existen y luego si ejecuta main
document.addEventListener("DOMContentLoaded", main);


// ── FLUJO MENTAL ────────────────────────────────────────────────────────────────────

// index.html carga
// ↓
// ArcGIS SDK empieza a cargar
// ↓
// DOMContentLoaded
// ↓
// main()
// ↓
// waitForArcGISSDK()
// ↓
// registrar adaptador
// ↓
// crear mapa/vistas
// ↓
// resolverAmbitoTerritorial() → municipiosDisponibles + mascaraInicial
// ↓
// (si hay mascaraInicial) cargarAmbitoTerritorial() → capas territoriales +
//                          máscara + zoom (antes: solo máscara + zoom)
// ↓
// montar UI (selector recibe municipiosDisponibles ya resuelto)
// ↓
// usuario selecciona municipio
// ↓ (bifurca según ambitoTerritorial, ver municipioSelector._onMunicipioChange)
// ├─ "municipio" → configEngine.fetchCapas() → reconstruye todo (Modelo A)
// └─ "provincia"/"ccaa" → configEngine.fetchCapasMunicipales() → SUMA
//                          capas municipales sin tocar la base territorial
// ↓
// layerFactory crea capas
// ↓
// mapManager las añade (addCapas reemplaza | addCapa suma, según el caso)
// ↓
// eventBus notifica
// ↓
// layerTree y legend reaccionan //