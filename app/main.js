/**
 * main.js
 *
 * Punto de entrada y orquestador de la aplicación GIS Municipal.
 *
 * ── RESPONSABILIDAD ÚNICA ────────────────────────────────────────────────
 * Arrancar la app en el orden correcto:
 *   1. Registrar el adaptador de datos (Repository Pattern)
 *   2. Inicializar el mapa
 *   3. Montar los módulos de UI
 * Sin lógica propia. Todo está delegado a los módulos especializados.
 *
 * ── LA ÚNICA DECISIÓN QUE TOMA main.js ───────────────────────────────────
 * Qué adaptador usar. Para cambiar de fuente de datos solo hay que cambiar
 * esta línea:
 *   setAdaptador(new LocalJsonAdapter(...))
 *    →  setAdaptador(new RestApiAdapter("https://api.ejemplo.com/capas"))
 *    →  setAdaptador(new PostGISAdapter(config))
 * Ningún otro archivo cambia.
 */

// ── Config ──────────────────────────────────────────────────────────────
import { LocalJsonAdapter }        from "../config/adapters/LocalJsonAdapter.js";
import { setAdaptador }            from "../config/configEngine.js"; // le dice al sistema qué fuente de datos usar
import { DEPLOYMENT }              from "../config/deployment.js";


// ── Core ─────────────────────────────────────────────────────────────────
// Main no crea el mapa directamente, lo inicializa 
import * as mapManager from "../core/mapManager.js";


// ── Lang ─────────────────────────────────────────────────────────────────
import { init as initI18n } from "../config/i18n/i18nManager.js";

// ── UI ────────────────────────────────────────────────────────────────────
// Cada función importada monta una parte visual
import { initActionBar } from "../ui/actionBar.js";
import { renderMunicipioSelector } from "../ui/municipioSelector.js";
import { renderBasemapSelector }   from "../ui/basemapSelector.js";
import { initLayerTree }           from "../ui/layerTree.js";
import { initLegendPanel }         from "../ui/legendPanel.js";
import { initToolbar }             from "../ui/toolbar.js";
import * as eventBus from '../utils/eventBus.js';




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
    // await porque crear el mapa es asíncono
    // espera que las acciones de initMap esten ok antes de renderizar otro componente de la interfaz
    await mapManager.initMap({
      mapContainerId:   "map-view", //conecta con index <div id="map-view"> y usado como parametro en initMap en mapManager.js
      sceneContainerId: "scene-view" // contacta con index <div id="scene-view"> y usado como parametro en initMap en mapManager.js
    });
    

    // 5. Montar UI
    // El orden importa: la toolbar y el selector están en la cabecera (visibles de entrada).
    // El árbol y la leyenda se construyen cuando "municipio-cargado" se emite con EVENTBUS
    initActionBar(); // inicializa actionbar
    renderMunicipioSelector("#municipio-selector-container", DEPLOYMENT); // styles & eventBus.emit("municipio-cargado")
    renderBasemapSelector("#basemap-selector-container"); // conecta con styles
    initLayerTree("#layer-tree-container"); // conecta con styles 
    initLegendPanel("map-view");  // conecta con styles, index (mapa inicia en 2d)
    initToolbar(document.getElementById("lang-selector-container")); //toolbar se especializa en el cambio de idioma
    
          // ─── AÑADIR AQUÍ LA LÓGICA DINÁMICA ───
      

      eventBus.on("municipio-cargado", ({ municipioData }) => {
        const navLogo = document.querySelector("calcite-navigation-logo");
        
        // Si el municipio tiene un logo definido en municipios.js, lo aplicamos
        if (navLogo && municipioData.logo) {
          navLogo.setAttribute("thumbnail", municipioData.logo);
          navLogo.setAttribute("heading", municipioData.nombre);
          navLogo.removeAttribute("icon"); // Calcite requiere quitar el icono para mostrar el thumbnail
        }
      })

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
// montar UI
// ↓
// usuario selecciona municipio
// ↓
// configEngine resuelve capas
// ↓
// layerFactory crea capas
// ↓
// mapManager las añade
// ↓
// eventBus notifica
// ↓
// layerTree y legend reaccionan //