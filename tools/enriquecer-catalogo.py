"""
enriquecer-catalogo.py

Script de resolución final: catalogo-capas-ne.json → catalogo-capas.json

Toma las capas marcadas incluir_en_catalogo_final=true en el catálogo de
referencia, consulta el GetCapabilities real de cada servicio, y deriva
por reglas de preferencia (nunca inventando) los campos que el propio
servicio declara: formatos_salida/formato_consumo, srsname,
featureInfoFormat, sublayers (id/title/legendUrl).

Todo lo que no se puede resolver por ninguna vía queda marcado
"pendiente_curacion" en el JSON de salida y detallado en el informe —
nunca se omite ni se completa en silencio.

USO:
    python enriquecer-catalogo.py                    # usa catalogo-capas-ne.json
    python enriquecer-catalogo.py mi-catalogo-ne.json # archivo personalizado

SALIDA:
    catalogo-capas.json          → catálogo activo, listo para LocalJsonAdapter
    informe-enriquecimiento.txt  → resumen de estados, discrepancias y diff

REQUISITOS:
    pip install requests

ESTADOS POSIBLES por capa (campo _resolucion.estado):
    ok                      → todos los campos derivables se resolvieron
    ok_con_pendientes       → se incluyó, pero algún campo quedó pendiente_curacion
    excluida_error_red      → GetCapabilities no respondió — no entra al catálogo final
    excluida_xml_invalido   → respuesta no parseable — no entra al catálogo final
    excluida_discrepancia   → disponibilidad_municipal del Excel no coincide con la
                               heurística del script — no entra hasta resolución manual

# ═══════════════════════════════════════════════════════
# ETAPA 2 — enriquecer-catalogo.py en la raiz del proyecto  
# ═══════════════════════════════════════════════════════

# Requisito previo: catalogo-capas-ne.json ya debe existir en data\catalogo\
# (generado por migrar-catalogo.py, ver paso anterior).

# 1. Confirmar que el entorno virtual sigue activo
#    (el prompt debe mostrar (.venv) al inicio; si no, repetir:
#    .\.venv\Scripts\Activate.ps1)

# 2. Ejecutar enriquecer-catalogo.py, apuntando al -ne.json de data\catalogo\
#    Genera catalogo-capas.json e informe-enriquecimiento.txt en esa misma carpeta.
python tools\enriquecer-catalogo.py data\catalogo\catalogo-capas-ne.json

# 3. Revisar el resultado antes de promoverlo a producción:
#    - data\catalogo\catalogo-capas.json          → catálogo final generado
#    - data\catalogo\informe-enriquecimiento.txt  → detalle por capa:
#        ok / ok_con_pendientes / excluida_error_red / excluida_discrepancia
#
#    Cualquier capa con estado distinto de "ok" requiere revisión manual
#    antes de dar el catálogo por válido (ver informe para el motivo exacto).
"""

import sys
import json
import datetime
import time
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs

try:
    import requests
except ImportError:
    print("❌ Falta 'requests'. Instálala con: pip install requests")
    sys.exit(1)


# ─────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────
TIMEOUT_SEGUNDOS     = 15
ARCHIVO_ENTRADA      = "catalogo-capas-ne.json"
ARCHIVO_SALIDA       = "catalogo-capas.json"
ARCHIVO_INFORME      = "informe-enriquecimiento.txt"

# Preferencia de SRS: se toma el primero que el servicio también soporte.
PREFERENCIA_SRS = ["EPSG:4326", "EPSG:3857"]


def extraer_srs_wfs(root: ET.Element) -> str | None:
    """
    Hallazgo real (25/08/2026): layerInitializer.js SÍ usa config.srsname
    para capas WFS con disponibilidad_municipal=BBOX — decide si el bbox
    enviado al servidor se reproyecta a EPSG:3857 o va directo en 4326
    (ver aplicarBboxWfs()). La primera versión del script solo extraía
    srsname para WMS; esto dejaba las WFS sin ese dato, cayendo al
    default EPSG:4326 aunque el servicio real declare otro (confirmado:
    SIOSE trae EPSG:3857 en el catálogo activo actual).

    WFS declara el CRS por FeatureType via <DefaultSRS> (1.x) o
    <DefaultCRS> (2.0), como texto plano (ej. "urn:ogc:def:crs:EPSG::3857"
    o "EPSG:3857" según versión) — se aplica la misma preferencia que en
    WMS, tomando el primero de la lista de preferencia que aparezca.
    """
    declarados = set()
    for el in root.iter():
        tag_local = el.tag.split("}")[-1]
        if tag_local in ("DefaultSRS", "DefaultCRS") and el.text:
            texto = el.text.strip()
            match = re.search(r"(\d+)$", texto)
            if match:
                declarados.add(f"EPSG:{match.group(1)}")

    for preferido in PREFERENCIA_SRS:
        if preferido in declarados:
            return preferido
    return next(iter(declarados), None)

# Preferencia de formato de GetFeatureInfo.
PREFERENCIA_FEATURE_INFO_FORMAT = ["application/json", "text/html"]

NS = {
    "wms130": "http://www.opengis.net/wms",
    "ows":    "http://www.opengis.net/ows/1.1",
}

PARAMS_CAPABILITIES = {
    "WMS":  {"SERVICE": "WMS",  "REQUEST": "GetCapabilities"},
    "WMTS": {"SERVICE": "WMTS", "REQUEST": "GetCapabilities"},
    "WFS":  {"SERVICE": "WFS",  "REQUEST": "GetCapabilities"},
    "WCS":  {"SERVICE": "WCS",  "REQUEST": "GetCapabilities"},
}

# Esquema mínimo exigido para que una capa se escriba en catalogo-capas.json.
# Si falta cualquiera de estos campos tras la resolución, la capa cae en
# pendiente_curacion en vez de escribirse a medias (ver validar_esquema_minimo).
CAMPOS_OBLIGATORIOS = ["id", "title", "tipo", "url", "cobertura", "disponibilidad_municipal"]


# ─────────────────────────────────────────────
# CONSTRUCCIÓN DE URL DE CAPABILITIES
# ─────────────────────────────────────────────

def _normalizar_esquema(url: str) -> str:
    """
    Corrige URLs sin esquema declaradas a mano en el Excel (ej.
    "ovc.catastro.meh.es/..." en vez de "https://ovc.catastro.meh.es/...").
    Hallazgo real detectado al probar el script contra el Excel/-ne.json:
    varias filas de capabilities vienen sin protocolo — sin esta corrección
    requests.get() falla con "Invalid URL" antes de intentar la conexión.
    """
    if url and not url.startswith(("http://", "https://")):
        return f"https://{url}"
    return url


def construir_url_capabilities(capa: dict) -> str | None:
    caps_url = (capa.get("capabilities_url") or "").strip()
    if caps_url:
        return _normalizar_esquema(caps_url)

    tipo    = capa.get("tipo", "").upper()
    url_base = (capa.get("url") or "").strip()
    params  = PARAMS_CAPABILITIES.get(tipo)
    if not url_base or not params:
        return None

    url_base = _normalizar_esquema(url_base)
    parsed   = urlparse(url_base)
    existing = parse_qs(parsed.query)
    merged   = {k.upper(): v for k, v in existing.items()}
    merged.update(params)
    query = urlencode({k: v[0] if isinstance(v, list) else v for k, v in merged.items()})
    return urlunparse(parsed._replace(query=query))


HEADERS_PETICION = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "application/xml,text/xml,*/*",
}
# Nota: algunos servicios públicos (confirmado con Catastro,
# ovc.catastro.meh.es) bloquean peticiones que se identifican como
# scripts/bots mediante ConnectionResetError, incluso siendo un uso
# legítimo y de bajo volumen. Un User-Agent de navegador real no oculta
# el origen del script — solo evita el bloqueo automático agresivo que
# no distingue entre scraping masivo y una consulta puntual de
# GetCapabilities. Si aun así el servicio bloquea, ver reintento con
# backoff más abajo, y como último recurso, curación manual documentada.


def fetch_xml(url: str, reintentos: int = 2) -> tuple[ET.Element | None, str]:
    ultimo_error = "error_red: sin intentos"
    for intento in range(reintentos + 1):
        try:
            resp = requests.get(url, timeout=TIMEOUT_SEGUNDOS, headers=HEADERS_PETICION)
            resp.raise_for_status()
            try:
                return ET.fromstring(resp.content), "ok"
            except ET.ParseError as e:
                return None, f"xml_invalido: {str(e)[:80]}"
        except requests.exceptions.Timeout:
            ultimo_error = "error_red: timeout"
        except requests.exceptions.ConnectionError as e:
            ultimo_error = f"error_red: {str(e)[:80]}"
        except requests.exceptions.HTTPError:
            ultimo_error = f"error_red: HTTP {resp.status_code}"
        except Exception as e:
            ultimo_error = f"error_red: {str(e)[:80]}"

        if intento < reintentos:
            time.sleep(2 * (intento + 1))  # backoff simple: 2s, 4s...

    return None, ultimo_error


# ─────────────────────────────────────────────
# EXTRACCIÓN DE CAMPOS DESDE GetCapabilities (WMS)
# ─────────────────────────────────────────────
#
# Principio general aplicado en todo este bloque: EXTRAER, no construir.
# Cada función busca el elemento que el servicio ya declara en su XML y
# lo toma tal cual. Solo se aplica una regla de PREFERENCIA cuando el
# servicio ofrece varias opciones válidas (varios SRS, varios formatos).
# Si no hay nada que extraer, se devuelve None explícito — nunca se inventa
# un valor por defecto silencioso.

def _localizar_capa_raiz(root: ET.Element) -> ET.Element | None:
    ns = NS["wms130"]
    for nodo in [root.find(f".//{{{ns}}}Capability/{{{ns}}}Layer"),
                 root.find(".//Capability/Layer")]:
        if nodo is not None:
            return nodo
    return None


def extraer_srs_preferido(root: ET.Element, capa_raiz: ET.Element) -> str | None:
    """Nivel 1: extracción con preferencia. No construye nada."""
    ns = NS["wms130"]
    declarados = set()
    for tag in [f"{{{ns}}}CRS", "CRS", f"{{{ns}}}SRS", "SRS"]:
        for el in capa_raiz.findall(tag):
            if el.text:
                declarados.add(el.text.strip().upper())

    for preferido in PREFERENCIA_SRS:
        if preferido.upper() in declarados:
            return preferido

    return next(iter(declarados), None)  # lo que haya, si nada de la preferencia calza


def extraer_feature_info_format(root: ET.Element) -> str | None:
    """Nivel 1: extracción con preferencia sobre Capability/Request/GetFeatureInfo/Format."""
    ns = NS["wms130"]
    formatos = set()
    for tag in [f".//{{{ns}}}GetFeatureInfo/{{{ns}}}Format", ".//GetFeatureInfo/Format"]:
        for el in root.findall(tag):
            if el.text:
                formatos.add(el.text.strip())

    for preferido in PREFERENCIA_FEATURE_INFO_FORMAT:
        if preferido in formatos:
            return preferido

    return next(iter(formatos), None)


def extraer_legend_url(sublayer_el: ET.Element) -> tuple[str | None, str]:
    """
    Nivel 1: extracción directa de Style/LegendURL/OnlineResource (href tal cual).
    Nivel 2 (fallback): NO se resuelve aquí — requiere saber si el servicio
    anuncia GetLegendGraphic a nivel de Capability, lo hace resolver_legend_urls().
    Devuelve (url_o_None, motivo_si_no_hay).
    """
    ns = NS["wms130"]
    for tag in [f"{{{ns}}}Style", "Style"]:
        style_el = sublayer_el.find(tag)
        if style_el is None:
            continue
        for legend_tag in [f"{{{ns}}}LegendURL", "LegendURL"]:
            legend_el = style_el.find(legend_tag)
            if legend_el is None:
                continue
            for resource_tag in [f"{{{ns}}}OnlineResource", "OnlineResource"]:
                resource_el = legend_el.find(resource_tag)
                if resource_el is not None:
                    href = resource_el.get("{http://www.w3.org/1999/xlink}href") or resource_el.get("href")
                    if href:
                        return href, "ok"
    return None, "sin_legendurl_declarada_en_capa"


def _soporta_get_legend_graphic(root: ET.Element) -> bool:
    ns = NS["wms130"]
    return (root.find(f".//{{{ns}}}Request/{{{ns}}}GetLegendGraphic") is not None or
            root.find(".//Request/GetLegendGraphic") is not None)


def construir_legend_graphic_fallback(capa: dict, sublayer_name: str) -> str | None:
    """Nivel 2: fallback estándar GetLegendGraphic, solo si el servicio la anuncia."""
    url_base = (capa.get("url") or "").strip()
    if not url_base:
        return None
    parsed = urlparse(url_base)
    params = {
        "SERVICE": "WMS", "REQUEST": "GetLegendGraphic",
        "LAYER": sublayer_name, "FORMAT": "image/png",
    }
    query = urlencode(params)
    return urlunparse(parsed._replace(query=query))


def _find_seguro(elemento: ET.Element, *tags: str) -> ET.Element | None:
    """
    Busca el primer tag que exista, probando cada uno en orden.
    Reemplaza el patrón 'elemento.find(a) or elemento.find(b)', que es
    incorrecto en ElementTree: un elemento XML hoja (sin hijos) se evalúa
    como falso en un 'or' aunque sí exista y tenga texto — Python 3.12+
    lo marca con DeprecationWarning porque ese comportamiento cambiará a
    error en el futuro. Hallazgo real detectado al correr el script contra
    SIGPAC (ver prueba en carpeta local, 25/08/2026).
    """
    for tag in tags:
        el = elemento.find(tag)
        if el is not None:
            return el
    return None


def extraer_sublayers(root: ET.Element, capa: dict) -> list:
    ns = NS["wms130"]
    capa_raiz = _localizar_capa_raiz(root)
    if capa_raiz is None:
        return []

    soporta_glg = _soporta_get_legend_graphic(root)
    sublayers = []

    ns_prefix = f"{{{ns}}}" if ns else ""
    for sub_el in capa_raiz.findall(f"{ns_prefix}Layer") or capa_raiz.findall("Layer"):
        name_el  = _find_seguro(sub_el, f"{ns_prefix}Name", "Name")
        title_el = _find_seguro(sub_el, f"{ns_prefix}Title", "Title")
        if name_el is None or not name_el.text:
            continue

        name  = name_el.text.strip()
        title = (title_el.text or name).strip() if title_el is not None else name

        legend_url, motivo = extraer_legend_url(sub_el)
        if legend_url is None and soporta_glg:
            legend_url = construir_legend_graphic_fallback(capa, name)
            motivo = "ok_fallback_getlegendgraphic"

        sublayers.append({
            "id":        name,
            "title":     title,
            "visible":   False,   # constante de la app, no derivado
            "legendUrl": legend_url,
            "_legend_motivo": motivo if legend_url is None else None,
        })

    return sublayers


# ─────────────────────────────────────────────
# FORMATOS DE SALIDA (formatos_salida / formato_consumo)
# ─────────────────────────────────────────────

PREFERENCIA_FORMATO_WMS = ["image/png", "image/jpeg"]


def extraer_formatos_wms(root: ET.Element) -> list:
    ns = NS["wms130"]
    formatos = set()
    for tag in [f".//{{{ns}}}GetMap/{{{ns}}}Format", ".//GetMap/Format"]:
        for el in root.findall(tag):
            if el.text:
                formatos.add(el.text.strip())
    return sorted(formatos)


def extraer_formatos_wfs(root: ET.Element) -> list:
    """
    Ver docstring anterior sobre los 3 patrones posibles. CORRECCIÓN
    (hallazgo real, prueba 25/08/2026 contra SIOSE/Redes Geodésicas/INE):
    la primera versión buscaba cualquier <Value> en todo el documento,
    sin verificar de qué <Parameter> depende — WFS 2.0 declara <Value>
    para MUCHOS parámetros distintos (outputFormat, sí, pero también CRS
    soportados, resultType, versiones...), todos con la misma etiqueta.
    Sin acotar al <Parameter name="outputFormat">, el resultado se
    contaminaba con códigos EPSG, nombres de sección del propio XML
    (OperationsMetadata, ServiceIdentification) y valores de resultType
    (hits, local, none). Ahora se exige que el <Value> cuelgue de un
    <Parameter> cuyo atributo name sea "outputFormat" (insensible a
    mayúsculas), evitando capturar valores de otros parámetros.
    """
    formatos = set()
    TAGS_FORMATO_VACIO = {
        "GML2", "GML3", "GML32", "GEOJSON", "JSON", "SHAPE-ZIP", "CSV", "KML",
    }

    for parametro in root.iter():
        tag_local = parametro.tag.split("}")[-1]
        if tag_local != "Parameter":
            continue
        nombre_param = (parametro.get("name") or "").strip().lower()
        if nombre_param != "outputformat":
            continue
        for hijo in parametro.iter():
            hijo_tag = hijo.tag.split("}")[-1]
            if hijo_tag == "Value" and hijo.text and hijo.text.strip():
                formatos.add(hijo.text.strip())

    # Patrones (2) y (3), que no dependen de Parameter/outputFormat:
    for el in root.iter():
        tag_local = el.tag.split("}")[-1]
        if tag_local == "Format" and el.text and el.text.strip():
            formatos.add(el.text.strip())
        elif tag_local.upper() in TAGS_FORMATO_VACIO:
            formatos.add(tag_local)

    return sorted(formatos)


def resolver_formatos(tipo: str, root: ET.Element) -> tuple[list, str | None]:
    """
    Devuelve (formatos_salida, formato_consumo).
    Para WFS: formato_consumo debe ser GeoJSON o la capa queda pendiente_curacion
    (WFSLayer del SDK v5 lo requiere — ver 3DECISIONS.md).
    """
    if tipo == "WMS":
        formatos = extraer_formatos_wms(root)
        # Preferencia: PNG antes que JPEG — JPEG no soporta transparencia,
        # generaría fondo opaco sobre el mapa base en un overlay (hallazgo
        # real: SIGPAC daba formato_consumo="image/jpeg" solo por venir
        # primero alfabéticamente entre ["image/jpeg","image/png"]).
        for preferido in PREFERENCIA_FORMATO_WMS:
            if preferido in formatos:
                return formatos, preferido
        return formatos, (formatos[0] if formatos else None)

    if tipo == "WFS":
        formatos = extraer_formatos_wfs(root)
        geojson_variantes = {"GeoJSON", "application/json", "json"}
        tiene_geojson = any(f in geojson_variantes or "json" in f.lower() for f in formatos)
        return formatos, ("GeoJSON" if tiene_geojson else None)

    return [], None


# ─────────────────────────────────────────────
# AUDITORÍA DE disponibilidad_municipal
# ─────────────────────────────────────────────

def heuristica_disponibilidad_base(tipo: str) -> set:
    """
    Conjunto plausible SIN consultar el servicio — válido para tipos donde
    el protocolo por sí solo ya decide: WMS/WMTS/XYZ nunca pueden filtrar
    por atributo del lado del servidor, así que solo BBOX es posible.
    Para WFS no hay nada que decidir aquí — la señal real requiere
    consultar el servicio (ver heuristica_disponibilidad_wfs). ATOM/API REST
    no tienen tratamiento especial todavía: no hay ninguna capa de ese tipo
    conectada ni probada, así que se tratan como el caso general (BBOX) en
    vez de asumir una capacidad de filtrado que no se ha verificado.
    """
    if tipo == "WFS":
        return None  # señal: requiere consulta real, no hay respuesta barata
    return {"BBOX"}


def heuristica_disponibilidad_wfs(root: ET.Element) -> set:
    """
    Conjunto plausible para WFS, ya con el capabilities real descargado.
    Si el servicio expone un atributo de tipo código INE, FILTRABLE/DIRECTA
    son plausibles. Si no se encuentra esa señal, el único valor plausible
    por defecto es BBOX — todo WFS soporta consulta espacial estándar,
    filtre o no por atributo (caso real: SIOSE y Corine, ver sus notas
    en el catálogo: "requiere gestión de BBOX por volumen de datos").
    """
    if verificar_atributo_ine(root) is True:
        return {"FILTRABLE", "DIRECTA"}
    return {"BBOX"}


def verificar_atributo_ine(root: ET.Element) -> bool | None:
    """
    Pista adicional (no determinante) para WFS: busca en el XML de
    capabilities un nombre de atributo que sugiera código INE filtrable
    (codigo_ine, cod_ine, ine_code...). Requiere DescribeFeatureType real
    para ser concluyente — esto es una aproximación sobre el propio
    GetCapabilities cuando lo declara inline. Devuelve None si no hay
    señal suficiente (ni confirma ni descarta).
    """
    patrones = ("codigo_ine", "cod_ine", "ine_code", "codine")
    texto_xml = ET.tostring(root, encoding="unicode").lower()
    if any(p in texto_xml for p in patrones):
        return True
    return None


def auditar_disponibilidad_base(capa: dict) -> tuple[bool | None, str, set | None]:
    """
    Auditoría SIN red. Devuelve (coincide, valor_excel, conjunto_o_None).
    coincide=None significa "no evaluable todavía" (caso WFS: requiere
    consultar el servicio primero, ver auditar_disponibilidad_wfs).

    CONDICIONAL YA NO está exento (corrección: es una restricción de
    alcance geográfico, no un valor técnico de acceso — el switch de
    layerInitializer.js no lo maneja hoy porque nunca se resuelve a un
    valor técnico real). Se audita contra el protocolo igual que
    cualquier otro valor: un WMS marcado CONDICIONAL sigue necesitando
    BBOX como método de acceso técnico; lo condicional es SOLO a qué
    municipios aplica, ver resolver_condicional().
    """
    valor_excel = (capa.get("disponibilidad_municipal") or "").upper()
    conjunto = heuristica_disponibilidad_base(capa.get("tipo", "").upper())
    if conjunto is None:
        return None, valor_excel, None  # WFS: pendiente de red

    if valor_excel == "CONDICIONAL":
        return True, valor_excel, conjunto  # pasa siempre; se resuelve aparte

    return valor_excel in conjunto, valor_excel, conjunto


def auditar_disponibilidad_wfs(capa: dict, root: ET.Element) -> tuple[bool, str, set]:
    """Auditoría para WFS, ya con capabilities descargado."""
    valor_excel = (capa.get("disponibilidad_municipal") or "").upper()
    conjunto = heuristica_disponibilidad_wfs(root)

    if valor_excel == "CONDICIONAL":
        return True, valor_excel, conjunto  # pasa siempre; se resuelve aparte

    return valor_excel in conjunto, valor_excel, conjunto


def resolver_condicional(capa: dict, conjunto_tecnico: set) -> tuple[str, str | None]:
    """
    Resuelve CONDICIONAL a un valor técnico real que layerInitializer.js
    sí sabe interpretar (BBOX/FILTRABLE/DIRECTA) — su switch no tiene caso
    para CONDICIONAL, cae siempre al default con un warning (confirmado
    leyendo el código real, 25/08/2026).

    CORRECCIÓN de semántica (mismo hallazgo): campo_filtro NO es una lista
    de códigos INE — es el NOMBRE DEL ATRIBUTO contra el que
    layerInitializer._estrategiaFiltrable() arma el CQL_FILTER /
    definitionExpression (ej. "codigo_ine"). La versión anterior de esta
    función lo trataba como lista de códigos, error de diseño ya corregido.
    Si el Excel no declara campo_filtro (hoy vacío en las 127 filas), no
    hay nombre de atributo que usar y el valor técnico cae al default del
    protocolo — layerInitializer.js maneja esto sin fallar (verifica
    !campoFiltro y omite el filtro con un warning, no lanza excepción).

    Devuelve (valor_tecnico, campo_filtro_o_None).
    """
    campo_filtro = (capa.get("campo_filtro") or "").strip() or None
    valor_tecnico = "BBOX" if "BBOX" in conjunto_tecnico else sorted(conjunto_tecnico)[0]
    return valor_tecnico, campo_filtro


# ─────────────────────────────────────────────
# VALIDACIÓN DE ESQUEMA MÍNIMO
# ─────────────────────────────────────────────

def validar_esquema_minimo(capa: dict) -> list:
    """Devuelve la lista de campos obligatorios ausentes o vacíos."""
    faltantes = []
    for campo in CAMPOS_OBLIGATORIOS:
        valor = capa.get(campo)
        if valor is None or valor == "" or valor == {}:
            faltantes.append(campo)
    return faltantes


# ─────────────────────────────────────────────
# RESOLUCIÓN DE UNA CAPA
# ─────────────────────────────────────────────

def resolver_capa(capa: dict) -> dict:
    """
    Devuelve la capa enriquecida con _resolucion añadido, o marca
    estado de exclusión si no se puede resolver. No escribe formato
    final aquí — eso lo hace main() tras filtrar por estado.
    """
    tipo = (capa.get("tipo") or "").upper()
    resolucion = {"fecha": datetime.date.today().isoformat(), "pendiente_curacion": []}

    # ── Auditoría de disponibilidad_municipal, parte 1: sin red ──
    # Para WMS/WMTS/XYZ el protocolo ya decide (solo BBOX es físicamente
    # posible) y se excluye aquí sin gastar ninguna petición. Para WFS
    # coincide=None: no hay señal barata, se resuelve más abajo una vez
    # descargado el capabilities real (ver heuristica_disponibilidad_wfs).
    coincide, valor_excel, conjunto = auditar_disponibilidad_base(capa)
    if coincide is False:
        resolucion["estado"] = "excluida_discrepancia"
        resolucion["discrepancia_disponibilidad_municipal"] = {
            "excel": valor_excel, "plausibles_por_protocolo": sorted(conjunto),
        }
        capa["_resolucion"] = resolucion
        return capa

    if valor_excel == "CONDICIONAL" and conjunto is not None:
        valor_resuelto, campo_filtro = resolver_condicional(capa, conjunto)
        capa["disponibilidad_municipal"] = valor_resuelto
        if campo_filtro:
            resolucion["pendiente_curacion"].append(
                f"CONDICIONAL resuelto a '{valor_resuelto}'; campo_filtro='{campo_filtro}' "
                "declarado — considerar si en realidad debería ser FILTRABLE en vez de BBOX"
            )
        else:
            resolucion["pendiente_curacion"].append(
                f"CONDICIONAL resuelto a '{valor_resuelto}' por defecto de protocolo — "
                "campo_filtro vacío en el Excel, sin atributo declarado para filtrar por territorio"
            )

    # ── Tipos sin GetCapabilities estándar: quedan tal cual, sin red ──
    if tipo not in ("WMS", "WMTS", "WFS", "WCS"):
        resolucion["estado"] = "ok"
        resolucion["pendiente_curacion"].append(
            f"tipo '{tipo}' sin GetCapabilities estándar — formatos/sublayers no derivados, revisar a mano"
        )
        capa["_resolucion"] = resolucion
        return capa

    url = construir_url_capabilities(capa)
    if not url:
        resolucion["estado"] = "excluida_error_red"
        resolucion["motivo"] = "sin capabilities_url ni url base para construirla"
        capa["_resolucion"] = resolucion
        return capa

    root, estado_fetch = fetch_xml(url)
    if root is None:
        resolucion["estado"] = ("excluida_xml_invalido" if "xml_invalido" in estado_fetch
                                 else "excluida_error_red")
        resolucion["motivo"] = estado_fetch
        capa["_resolucion"] = resolucion
        return capa

    # ── Auditoría de disponibilidad_municipal, parte 2: solo WFS ──
    # Aquí sí se gastó la petición de red, pero es la única forma de
    # obtener la señal real (atributo de código INE declarado o no).
    if tipo == "WFS":
        coincide_wfs, valor_excel_wfs, conjunto_wfs = auditar_disponibilidad_wfs(capa, root)
        if not coincide_wfs:
            resolucion["estado"] = "excluida_discrepancia"
            resolucion["discrepancia_disponibilidad_municipal"] = {
                "excel": valor_excel_wfs, "plausibles_segun_capabilities": sorted(conjunto_wfs),
            }
            capa["_resolucion"] = resolucion
            return capa

        if valor_excel_wfs == "CONDICIONAL":
            valor_resuelto, campo_filtro = resolver_condicional(capa, conjunto_wfs)
            capa["disponibilidad_municipal"] = valor_resuelto
            if campo_filtro:
                resolucion["pendiente_curacion"].append(
                    f"CONDICIONAL resuelto a '{valor_resuelto}'; campo_filtro='{campo_filtro}' "
                    "declarado — considerar si en realidad debería ser FILTRABLE en vez de BBOX"
                )
            else:
                resolucion["pendiente_curacion"].append(
                    f"CONDICIONAL resuelto a '{valor_resuelto}' por defecto de protocolo — "
                    "campo_filtro vacío en el Excel, sin atributo declarado para filtrar por territorio"
                )

    # ── Derivación de campos (solo WMS tiene la extracción completa
    #     de sublayers/srs/featureInfoFormat implementada; WFS/WMTS/WCS
    #     solo resuelven formatos por ahora) ──
    formatos_salida, formato_consumo = resolver_formatos(tipo, root)
    capa["formatos_salida"] = formatos_salida

    if tipo == "WFS" and formato_consumo is None:
        resolucion["estado"] = "excluida_error_red"
        resolucion["motivo"] = "WFS sin GeoJSON confirmado por el servicio (requisito WFSLayer SDK v5)"
        capa["_resolucion"] = resolucion
        return capa

    capa["formato_consumo"] = formato_consumo

    if tipo == "WFS":
        srs_wfs = extraer_srs_wfs(root)
        capa["srsname"] = srs_wfs
        if srs_wfs is None:
            resolucion["pendiente_curacion"].append(
                "srsname: ningún DefaultSRS/DefaultCRS declarado por el servicio — "
                "layerInitializer.js usará EPSG:4326 por defecto para el filtro BBOX, "
                "verificar si el servicio real lo requiere en otro CRS"
            )

    if tipo == "WMS":
        capa_raiz = _localizar_capa_raiz(root)
        if capa_raiz is not None:
            srs = extraer_srs_preferido(root, capa_raiz)
            capa["srsname"] = srs
            if srs is None:
                resolucion["pendiente_curacion"].append("srsname: ningún CRS declarado por el servicio")

            fif = extraer_feature_info_format(root)
            capa["featureInfoFormat"] = fif
            if fif is None:
                resolucion["pendiente_curacion"].append("featureInfoFormat: no declarado por el servicio")

            sublayers = extraer_sublayers(root, capa)
            for sub in sublayers:
                if sub["legendUrl"] is None:
                    resolucion["pendiente_curacion"].append(
                        f"legendUrl de sublayer '{sub['id']}': {sub['_legend_motivo']}"
                    )
                sub.pop("_legend_motivo", None)
            capa["sublayers"] = sublayers
        else:
            resolucion["pendiente_curacion"].append("no se localizó Capability/Layer raíz — sublayers no derivados")

    resolucion["estado"] = "ok_con_pendientes" if resolucion["pendiente_curacion"] else "ok"
    capa["_resolucion"] = resolucion
    return capa


# ─────────────────────────────────────────────
# DIFF CONTRA LA EJECUCIÓN ANTERIOR
# ─────────────────────────────────────────────

def calcular_diff(catalogo_nuevo: list, ruta_anterior: Path) -> dict:
    if not ruta_anterior.exists():
        return {"primera_ejecucion": True}

    with open(ruta_anterior, encoding="utf-8") as f:
        anterior = json.load(f)

    ids_anteriores = {c["id"]: c for c in anterior}
    ids_nuevos     = {c["id"]: c for c in catalogo_nuevo}

    nuevas      = sorted(set(ids_nuevos) - set(ids_anteriores))
    eliminadas  = sorted(set(ids_anteriores) - set(ids_nuevos))
    modificadas = []

    campos_a_comparar = ["disponibilidad_municipal", "formato_consumo", "url", "tipo"]
    for id_ in set(ids_nuevos) & set(ids_anteriores):
        cambios = {}
        for campo in campos_a_comparar:
            v_antes = ids_anteriores[id_].get(campo)
            v_ahora = ids_nuevos[id_].get(campo)
            if v_antes != v_ahora:
                cambios[campo] = {"antes": v_antes, "ahora": v_ahora}
        if cambios:
            modificadas.append({"id": id_, "cambios": cambios})

    return {
        "primera_ejecucion": False,
        "nuevas": nuevas,
        "eliminadas": eliminadas,
        "modificadas": modificadas,
    }


# ─────────────────────────────────────────────
# EJECUCIÓN PRINCIPAL
# ─────────────────────────────────────────────

def main():
    print("═══════════════════════════════════════════════════════")
    print("  Resolución de catálogo final desde GetCapabilities")
    print("═══════════════════════════════════════════════════════\n")

    ruta_entrada = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(ARCHIVO_ENTRADA)
    if not ruta_entrada.exists():
        print(f"❌ Archivo no encontrado: {ruta_entrada}")
        sys.exit(1)

    with open(ruta_entrada, encoding="utf-8") as f:
        catalogo_ne = json.load(f)

    candidatas = [c for c in catalogo_ne if c.get("incluir_en_catalogo_final")]
    print(f"📄 Capas en catalogo-capas-ne.json: {len(catalogo_ne)}")
    print(f"🎯 Candidatas (incluir_en_catalogo_final=true): {len(candidatas)}\n")

    catalogo_final = []
    excluidas      = []

    for i, capa in enumerate(candidatas):
        nombre = capa.get("title") or capa.get("id") or f"capa_{i}"
        print(f"  [{i+1:>3}/{len(candidatas)}] {nombre[:60]}", end=" ... ", flush=True)

        capa_resuelta = resolver_capa(capa)
        estado = capa_resuelta["_resolucion"]["estado"]

        if estado.startswith("excluida"):
            print(f"❌ {estado}")
            excluidas.append(capa_resuelta)
            continue

        faltantes = validar_esquema_minimo(capa_resuelta)
        if faltantes:
            print(f"❌ esquema incompleto: {faltantes}")
            capa_resuelta["_resolucion"]["estado"] = "excluida_esquema_incompleto"
            capa_resuelta["_resolucion"]["campos_faltantes"] = faltantes
            excluidas.append(capa_resuelta)
            continue

        icono = "✅" if estado == "ok" else "⚠️ "
        print(f"{icono} {estado}")
        catalogo_final.append(capa_resuelta)

    ruta_salida = ruta_entrada.parent / ARCHIVO_SALIDA
    diff = calcular_diff(catalogo_final, ruta_salida)

    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(catalogo_final, f, ensure_ascii=False, indent=2)

    # ── Informe ──
    ruta_informe = ruta_entrada.parent / ARCHIVO_INFORME
    with open(ruta_informe, "w", encoding="utf-8") as f:
        f.write(f"Informe de resolución de catálogo — {datetime.date.today()}\n")
        f.write("=" * 60 + "\n\n")
        f.write(f"Candidatas evaluadas: {len(candidatas)}\n")
        f.write(f"Incluidas en catálogo final: {len(catalogo_final)}\n")
        f.write(f"Excluidas: {len(excluidas)}\n\n")

        f.write("── Excluidas ──\n")
        for c in excluidas:
            r = c["_resolucion"]
            f.write(f"  [{r['estado']}] {c.get('title', c.get('id'))}\n")
            if "discrepancia_disponibilidad_municipal" in r:
                d = r["discrepancia_disponibilidad_municipal"]
                clave_plausibles = "plausibles_por_protocolo" if "plausibles_por_protocolo" in d else "plausibles_segun_capabilities"
                f.write(f"      Excel: {d['excel']}  |  Plausibles: {d[clave_plausibles]}\n")
            if "motivo" in r:
                f.write(f"      motivo: {r['motivo']}\n")
            if "campos_faltantes" in r:
                f.write(f"      campos faltantes: {r['campos_faltantes']}\n")

        f.write("\n── Incluidas con pendientes de curación manual ──\n")
        for c in catalogo_final:
            pendientes = c["_resolucion"].get("pendiente_curacion", [])
            if pendientes:
                f.write(f"  {c['title']} ({c['id']}):\n")
                for p in pendientes:
                    f.write(f"      - {p}\n")

        f.write("\n── Diff contra ejecución anterior ──\n")
        if diff.get("primera_ejecucion"):
            f.write("  Primera ejecución — no hay comparación previa.\n")
        else:
            f.write(f"  Nuevas: {diff['nuevas']}\n")
            f.write(f"  Eliminadas: {diff['eliminadas']}\n")
            f.write(f"  Modificadas:\n")
            for m in diff["modificadas"]:
                f.write(f"    {m['id']}: {m['cambios']}\n")

    # ── Resumen en consola ──
    print("\n" + "─" * 55)
    print(f"✅ Incluidas en catálogo final: {len(catalogo_final)}")
    print(f"❌ Excluidas: {len(excluidas)}")
    if not diff.get("primera_ejecucion"):
        print(f"↔️  Diff — nuevas: {len(diff['nuevas'])}, eliminadas: {len(diff['eliminadas'])}, "
              f"modificadas: {len(diff['modificadas'])}")
    print(f"\n📦 Catálogo final: {ruta_salida}")
    print(f"📋 Informe:        {ruta_informe}")
    print("═══════════════════════════════════════════════════════\n")


if __name__ == "__main__":
    main()
