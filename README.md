# geo-modular-app

Visor GIS municipal configurable y adaptativo construido con **ArcGIS Maps SDK for JavaScript v5**, Web Components y ES Modules nativos. Desarrollado como TFM en el contexto de prácticas en una consultoría de soluciones digitales GIS.

---

## Problema que resuelve

Acceder y explotar datos de un municipio español hoy requiere navegar 7 o más portales distintos (Catastro, IDENA, INE, MITECO, Ayuntamiento…). Esta app los unifica en un único visor GIS.

## Visión

App web GIS **genérica y reutilizable**. Un único código base que sirve para cualquier municipio. Lo que cambia entre municipios es el catálogo de capas y la lógica de resolución — nunca el código de la aplicación.

```
[Catálogo de capas + reglas de cobertura]
          ↓
[configEngine: resuelve qué capas aplican al municipio]
          ↓
[App GIS genérica] → muestra solo las capas disponibles para ese municipio
```

---

## Stack técnico

| Tecnología | Uso |
|---|---|
| ArcGIS Maps SDK for JavaScript **v5** | Motor GIS y renderizado de mapas (requisito de tutor) |
| Calcite Components | UI (selectores, árboles, paneles, botones) |
| HTML + ES Modules nativos | Sin frameworks JS (React, Vue descartados) |
| Web Components first | `viewOnReady()`, `<arcgis-layer-list>`, `<arcgis-legend>` |
| Servicios OGC públicos | WMS, WMTS, WFS — sin licencia ArcGIS Online |
| OSM | Basemap por defecto (sin API Key) |

---

## Estructura del proyecto

```
gis-app/
│
├── app/
│   ├── index.html        # Shell HTML. Web Components declarados y carga del SDK.
│   ├── main.js           # Orquestador. Arranca la app, registra adaptador, conecta módulos.
│   └── styles.css        # Solo layout y overrides Calcite. Sin lógica.
│
├── config/
│   ├── municipios.js             # Lista de municipios disponibles (estructura compatible INE).
│   ├── catalogo-capas.json       # Catálogo único de capas con reglas de cobertura geográfica.
│   ├── configEngine.js           # Motor de resolución: dado un municipio, devuelve sus capas.
│   └── adapters/
│       ├── LocalJsonAdapter.js   # Lee el catálogo JSON local. Adaptador activo en el prototipo.
│       ├── RestApiAdapter.js     # (futuro) Llama a API REST propia.
│       └── PostGISAdapter.js     # (futuro) Consulta espacial con bbox via PostGIS.
│
├── core/
│   ├── mapManager.js             # Ciclo de vida del mapa: init, toggle 2D/3D, viewpoint, máscara municipal.
│   ├── layerFactory.js           # Fábrica: tipo string → instancia Esri. Incluye crearCapaWfsHija().
│   └── layerInitializer.js       # Filtros runtime BBOX / FILTRABLE / DIRECTA por municipio.
│
├── ui/
│   ├── municipioSelector.js      # Selector de municipio. Dispara resolución y carga de capas.
│   ├── layerTree.js              # Árbol de capas con discovery dinámico de FeatureTypes WFS.
│   ├── legendPanel.js            # Leyenda dinámica (solo capas activas).
│   ├── basemapSelector.js        # Selector de mapa base.
│   └── toolbar.js                # Barra superior: toggle 2D/3D y herramientas.
│
└── utils/
    ├── eventBus.js                 # Bus de eventos desacoplado entre módulos.
    ├── domUtils.js                 # Helpers DOM genéricos sin dependencia de ArcGIS.
    └── wfsCapabilitiesParser.js    # Parseo OGC GetCapabilities → FeatureTypeInfo[]. Agnóstico a versión WFS.
```


## Flujo principal

```
config/municipios.js
    ↓ usuario selecciona municipio
ui/municipioSelector.js
    ↓ municipioData { codigo_ine, ccaa_code, provincia_code, bbox }
config/configEngine.js → config/adapters/LocalJsonAdapter.js → catalogo-capas.json
    ↓ array de capas filtradas por cobertura
core/layerFactory.js → instancias Esri
    ↓
core/layerInitializer.js → filtros BBOX / FILTRABLE / DIRECTA
    ↓
core/mapManager.js → añade capas al mapa (WFS excluidas hasta activación)
    ↓ eventBus "municipio-cargado"
ui/layerTree.js → árbol DOM con nodos discovery para WFS
ui/legendPanel.js → leyenda dinámica
```

---

## Arrancar el proyecto

El proyecto no requiere build ni dependencias npm. Basta con servir los archivos estáticos:

```bash
# Con Python (desde la raíz del repo)
python -m http.server 8080

# Con VS Code Live Server
# Abrir index.html y pulsar "Go Live"
```

Abrir en el navegador: `http://localhost:8080/app/index.html`

> ⚠️ Debe servirse desde un servidor HTTP (no `file://`) por las restricciones CORS de los servicios WMS/WFS públicos.

---

## Evolución prevista

```
Fase actual (prototipo TFM)
  LocalJsonAdapter → catálogo JSON local
  Municipios: lista manual (~3-5 municipios de prueba)

Medio plazo
  RestApiAdapter → API REST propia
  Municipios: JSON completo INE (~8.200 municipios)

Futuro
  PostGISAdapter → consulta espacial real con bbox
  GeoServer / PostGIS para análisis que los servicios públicos no exponen
```

---

## Ramas

| Rama | Propósito |
|---|---|
| `main` | Código estable y validado |
| `dev` | Desarrollo activo |

---

## Contexto académico

Desarrollado como Trabajo de Fin de Máster en el contexto de prácticas en una consultoría de soluciones digitales GIS. El objetivo del TFM es demostrar una arquitectura GIS modular, configurable y escalable para administración local española, integrando fuentes de datos públicas (IGN, Catastro, INE, MITECO) en un único visor adaptativo.