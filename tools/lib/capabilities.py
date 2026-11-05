"""
tools/lib/capabilities.py — leer la autodescripción de un servicio.

Responsabilidad única: dado el XML de un GetCapabilities (WMS, WMTS, WFS,
WCS) o de un feed ATOM, EXTRAER lo que el servicio declara. No decide qué
capas entran en el catálogo ni aplica criterio editorial.

Principio heredado de enriquecer-catalogo.py: extraer, no construir. Si el
servicio no declara algo, se devuelve None/"desconocido"; nunca se inventa
un valor por defecto en silencio.

Por qué ElementTree con búsqueda por nombre local: los servidores usan
prefijos y versiones distintos (wms:, wfs:, ows:, sin prefijo; WMS 1.1.1 y
1.3.0; WFS 1.0, 1.1 y 2.0). Comparar el nombre sin namespace cubre todos con
una sola regla, el mismo criterio que querySelectorAll("FeatureType") en
utils/wfsCapabilitiesParser.js.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

# ── Utilidades de XML ────────────────────────────────────────────────────────

def local(el) -> str:
    return el.tag.split("}")[-1] if isinstance(el.tag, str) else ""


def hijos(el, nombre: str) -> list:
    return [h for h in el if local(h) == nombre]


def hijo(el, nombre: str):
    for h in el:
        if local(h) == nombre:
            return h
    return None


def todos(el, nombre: str) -> list:
    return [d for d in el.iter() if local(d) == nombre]


def texto(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def primer_texto(el, *ruta: str) -> str:
    """Texto del primer descendiente que siga la ruta de nombres locales."""
    actual = [el]
    for nombre in ruta:
        siguiente = []
        for a in actual:
            siguiente.extend(d for d in a.iter() if local(d) == nombre and d is not a)
        if not siguiente:
            return ""
        actual = siguiente[:1]
    return texto(actual[0])


class XmlNoValido(Exception):
    pass


class ExcepcionServicio(Exception):
    """El servidor respondió 200 con un informe de error OGC."""


def parsear(contenido: bytes):
    """
    Devuelve la raíz o lanza XmlNoValido / ExcepcionServicio.
    Se detecta ServiceExceptionReport y ows:ExceptionReport: hallazgo del
    30/08/2026 (Red Natura 2000): HTTP 200 con XML bien formado que es un
    error interno del servidor. Sin esta comprobación se tomaría por un
    capabilities vacío y el motivo real quedaría oculto.
    """
    try:
        root = ET.fromstring(contenido)
    except ET.ParseError as e:
        raise XmlNoValido(str(e)[:80]) from None
    if local(root) in ("ServiceExceptionReport", "ExceptionReport"):
        detalle = ""
        for d in root.iter():
            if local(d) in ("ServiceException", "ExceptionText") and texto(d):
                detalle = texto(d)
                break
        raise ExcepcionServicio((detalle or "sin detalle")[:200])
    return root


# ── Extensión geográfica (lon/lat siempre) ───────────────────────────────────
#
# Se leen SOLO los elementos que la norma fija en longitud/latitud:
#   WMS 1.3.0    EX_GeographicBoundingBox (campos con nombre, sin ambigüedad)
#   WMS 1.1.1    LatLonBoundingBox (atributos minx/miny = lon/lat)
#   WFS 1.0      LatLongBoundingBox (ídem)
#   WFS 1.1/2.0, WMTS, WCS 1.1+   ows:WGS84BoundingBox ("lon lat")
# Nunca BoundingBox con CRS: en EPSG:4326 la norma impone lat/lon y cada
# servidor lo aplica a su manera (origen del bug de ejes de SIOSE, P15).

# Caja aproximada de España con Canarias, Ceuta y Melilla. Solo se usa para
# la comprobación de sentido común de los ejes, no para decidir cobertura.
_ESPANA = (-18.5, 27.4, 4.6, 44.0)


def _union(cajas):
    cajas = [c for c in cajas if c]
    if not cajas:
        return None
    return (min(c[0] for c in cajas), min(c[1] for c in cajas),
            max(c[2] for c in cajas), max(c[3] for c in cajas))


def _float(v):
    try:
        return float(str(v).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def _caja(xmin, ymin, xmax, ymax):
    vals = [_float(v) for v in (xmin, ymin, xmax, ymax)]
    if any(v is None for v in vals):
        return None
    return tuple(vals)


def _cajas_declaradas(root) -> list:
    cajas = []
    for el in todos(root, "EX_GeographicBoundingBox"):
        cajas.append(_caja(primer_texto(el, "westBoundLongitude"),
                           primer_texto(el, "southBoundLatitude"),
                           primer_texto(el, "eastBoundLongitude"),
                           primer_texto(el, "northBoundLatitude")))
    for nombre in ("LatLonBoundingBox", "LatLongBoundingBox"):
        for el in todos(root, nombre):
            cajas.append(_caja(el.get("minx"), el.get("miny"),
                               el.get("maxx"), el.get("maxy")))
    for el in todos(root, "WGS84BoundingBox"):
        inf = primer_texto(el, "LowerCorner").split()
        sup = primer_texto(el, "UpperCorner").split()
        if len(inf) == 2 and len(sup) == 2:
            cajas.append(_caja(inf[0], inf[1], sup[0], sup[1]))
    return [c for c in cajas if c]


def _intersecta_espana(c) -> bool:
    return not (c[2] < _ESPANA[0] or c[0] > _ESPANA[2] or
                c[3] < _ESPANA[1] or c[1] > _ESPANA[3])


def extension_bbox(root) -> tuple[tuple | None, str]:
    """
    Devuelve (caja, nota). Caja = (xmin, ymin, xmax, ymax) en lon/lat.
    Red de seguridad: si la latitud se sale de [-90, 90], o si solo al
    invertir los ejes la caja toca España, se invierte y se devuelve la
    nota "ejes_invertidos_corregidos" para que quede visible qué servidor
    declara mal su extensión.
    """
    caja = _union(_cajas_declaradas(root))
    if caja is None:
        return None, ""
    invertida = (caja[1], caja[0], caja[3], caja[2])
    lat_imposible = abs(caja[1]) > 90 or abs(caja[3]) > 90
    if lat_imposible or (not _intersecta_espana(caja) and _intersecta_espana(invertida)):
        return invertida, "ejes_invertidos_corregidos"
    return caja, ""


def formatear_bbox(caja) -> str:
    """
    "[xmin, ymin, xmax, ymax]" con 4 decimales (~11 m, de sobra para
    sugerir cobertura). Entre corchetes a propósito: un valor que empieza
    por "-" Excel lo intenta interpretar como fórmula al pegar el TSV.
    """
    if not caja:
        return ""
    return "[" + ", ".join(f"{v:.4f}" for v in caja) + "]"


# ── Metadatos de servicio ────────────────────────────────────────────────────

def _bloque_servicio(root):
    """<Service> en WMS/WFS 1.0; <ServiceIdentification> en OWS (WFS 1.1+, WMTS, WCS)."""
    # Sin "a or b": un Element sin hijos se evalúa como falso aunque exista
    # (hallazgo de _find_seguro en enriquecer-catalogo.py, 25/08/2026).
    srv = hijo(root, "Service")
    return srv if srv is not None else hijo(root, "ServiceIdentification")


def titulo(root) -> str:
    srv = _bloque_servicio(root)
    return texto(hijo(srv, "Title")) if srv is not None else ""


def resumen(root) -> str:
    srv = _bloque_servicio(root)
    return texto(hijo(srv, "Abstract")) if srv is not None else ""


def proveedor(root) -> str:
    # WMS: Service/ContactInformation/ContactPersonPrimary/ContactOrganization
    # OWS: ServiceProvider/ProviderName
    org = primer_texto(root, "ContactOrganization")
    if org:
        return org
    sp = hijo(root, "ServiceProvider")
    return texto(hijo(sp, "ProviderName")) if sp is not None else ""


def licencia(root) -> str:
    srv = _bloque_servicio(root)
    if srv is None:
        return ""
    partes = []
    for nombre in ("AccessConstraints", "Fees"):
        for el in hijos(srv, nombre):
            t = texto(el)
            if t and t.lower() not in ("none", "ninguna", "ninguno", "no", "-"):
                partes.append(t)
    return " | ".join(dict.fromkeys(partes))


def keywords(root) -> list[str]:
    return [texto(k) for k in todos(root, "Keyword") if texto(k)]


# ── Servidor ─────────────────────────────────────────────────────────────────

# Firmas por las que se reconoce el software. Se buscan en la cabecera
# Server y en las URLs que el propio capabilities declara (OnlineResource,
# Get/Post href), que suelen delatar la ruta del producto.
_FIRMAS_SERVIDOR = [
    ("GeoServer", ("geoserver",)),
    ("ArcGIS Server", ("arcgis/services", "arcgis/rest", "arcgis server", "esri")),
    ("MapServer", ("mapserv", "mapserver")),
    ("deegree", ("deegree",)),
    ("QGIS Server", ("qgis_mapserv", "qgis server", "qgisserver")),
]


def servidor(root, cabecera_server: str = "", url: str = "") -> str:
    hrefs = " ".join(
        v for el in root.iter() for k, v in el.attrib.items() if k.endswith("href")
    )
    pistas = " ".join([cabecera_server, url, hrefs, " ".join(keywords(root))]).lower()
    for nombre, firmas in _FIRMAS_SERVIDOR:
        if any(f in pistas for f in firmas):
            return nombre
    return "desconocido"


# ── Orden de ejes WFS (mismo criterio que la app) ────────────────────────────
#
# Regla copiada de utils/wfsCapabilitiesParser.js (fetchFeatureTypes, paso 2)
# para que app e inspector decidan igual: ArcGIS Server publicado como WFS
# declara el keyword "ESRI(LongLat)" y entonces espera el BBOX como
# ymin,xmin,ymax,xmax. Con el orden estándar devuelve features:[] sin error
# (confirmado con SIOSE). Si se cambia la regla aquí, cambiarla también allí.

def orden_ejes_wfs(root) -> str:
    return "yx" if any("LongLat" in k for k in keywords(root)) else "xy"


def construir_bbox_wfs(caja, orden: str) -> str:
    """Cadena BBOX para GetFeature, idéntica a _buildBboxString de la app."""
    xmin, ymin, xmax, ymax = caja
    if orden == "yx":
        return f"{ymin},{xmin},{ymax},{xmax},EPSG:4326"
    return f"{xmin},{ymin},{xmax},{ymax},EPSG:4326"


# ── Formatos de salida WFS / GeoJSON ─────────────────────────────────────────

# Misma prioridad que _seleccionarOutputFormat en wfsCapabilitiesParser.js:
# geojson estándar antes que el propietario esrigeojson.
PRIORIDAD_JSON = ["application/json", "application/geo+json", "geojson", "esrigeojson"]


def formatos_salida_wfs(root) -> list[str]:
    """
    Valores de outputFormat de la operación GetFeature. Corrección heredada
    de enriquecer-catalogo.py (25/08/2026): WFS 2.0 declara <Value> para
    muchos parámetros (CRS, resultType...); se acota a Parameter
    name="outputFormat". Se prefiere el de GetFeature, como la app, porque
    el de DescribeFeatureType no suele ofrecer JSON.
    """
    def valores(contenedor):
        vals = []
        for p in todos(contenedor, "Parameter"):
            if (p.get("name") or "").strip().lower() == "outputformat":
                vals += [texto(v) for v in todos(p, "Value") if texto(v)]
        return vals

    for op in todos(root, "Operation"):
        if (op.get("name") or "").lower() == "getfeature":
            vals = valores(op)
            if vals:
                return sorted(set(vals))
    vals = valores(root)
    # WFS 1.0: <ResultFormat><GML2/><GEOJSON/></ResultFormat> (etiquetas vacías)
    for rf in todos(root, "ResultFormat"):
        vals += [local(h) for h in rf]
    # WFS 1.1: <OutputFormats><Format>...</Format></OutputFormats>
    for of in todos(root, "OutputFormats"):
        vals += [texto(f) for f in todos(of, "Format") if texto(f)]
    return sorted(set(vals))


def seleccionar_json(formatos: list[str]) -> str | None:
    candidatos = [f for f in formatos if "json" in f.lower()]
    for pref in PRIORIDAD_JSON:
        for c in candidatos:
            if c.lower() == pref:
                return c
    return candidatos[0] if candidatos else None


# ── Lectura por protocolo ────────────────────────────────────────────────────

def _operacion_declarada(root, nombre: str) -> bool:
    """Operación en <Request> (WMS) o en OperationsMetadata (OWS)."""
    if any(local(d) == nombre for d in root.iter()):
        return True
    return any((op.get("name") or "") == nombre for op in todos(root, "Operation"))


def leer(root, protocolo: str) -> dict:
    """
    Extrae los campos de la pieza 2a según el protocolo. Devuelve un dict con
    claves con el nombre exacto de las columnas de exploracion.
    """
    caja, nota_bbox = extension_bbox(root)
    datos = {
        "titulo_oficial": titulo(root),
        "resumen": resumen(root),
        "proveedor_detectado": proveedor(root),
        "licencia_detectada": licencia(root),
        "extension_bbox": formatear_bbox(caja),
        "_nota_bbox": nota_bbox,
    }

    if protocolo == "WMS":
        capas = [l for l in todos(root, "Layer") if hijo(l, "Name") is not None]
        consultable_px = any(l.get("queryable") == "1" for l in todos(root, "Layer"))
        datos.update({
            "n_capas": str(len(capas)),
            # identificable: el servicio anuncia GetFeatureInfo y al menos
            # una capa es queryable (sin las dos, el popup no funciona; ver
            # 3DECISIONS 01.07.26, popup WMS).
            "identificable": "si" if _operacion_declarada(root, "GetFeatureInfo") and consultable_px else "no",
            "consultable": "no",   # WMS devuelve imagen, no entidades
            "geojson": "no",
        })
    elif protocolo == "WMTS":
        contents = hijo(root, "Contents")
        capas = hijos(contents, "Layer") if contents is not None else []
        identificable = any(hijos(l, "InfoFormat") for l in capas) or \
            _operacion_declarada(root, "GetFeatureInfo")
        datos.update({
            "n_capas": str(len(capas)),
            "identificable": "si" if identificable else "no",
            "consultable": "no",
            "geojson": "no",
        })
    elif protocolo == "WFS":
        tipos = todos(root, "FeatureType")
        datos.update({
            "n_capas": str(len(tipos)),
            "identificable": "si",   # se piden entidades con atributos
            "consultable": "si",
            "geojson": "si" if seleccionar_json(formatos_salida_wfs(root)) else "no",
            "orden_ejes": orden_ejes_wfs(root),
        })
    elif protocolo == "WCS":
        coberturas = todos(root, "CoverageSummary") or todos(root, "CoverageOfferingBrief")
        datos.update({
            "n_capas": str(len(coberturas)),
            "identificable": "no",
            "consultable": "no",
            "geojson": "no",
        })
    elif protocolo == "ATOM":
        datos.update(leer_atom(root))
    return datos


def leer_atom(root) -> dict:
    """Feed ATOM INSPIRE: título, subtítulo, derechos y número de entradas."""
    return {
        "titulo_oficial": texto(hijo(root, "title")),
        "resumen": texto(hijo(root, "subtitle")),
        "proveedor_detectado": primer_texto(root, "author", "name"),
        "licencia_detectada": texto(hijo(root, "rights")),
        "n_capas": str(len(hijos(root, "entry"))),
        "identificable": "no",
        "consultable": "no",
        "geojson": "no",
    }


def limpiar_texto(t: str, n: int = 500) -> str:
    """Una sola línea, sin tabuladores (rompen el TSV), recortada."""
    return re.sub(r"\s+", " ", t or "").strip()[:n]
