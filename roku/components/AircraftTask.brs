' AircraftTask.brs — live aircraft around the viewer.
'
' Source: adsb.lol /v2 point query (free, no key, ODbL — attribution shown in-app).
' We deliberately use ONLY adsb.lol here: it permits commercial use with attribution,
' whereas adsb.fi / OpenSky are non-commercial and unsafe for a paid channel.
'
' Trigger pattern: the scene sets `observer` + `rangeNm`, then control = "RUN".
' We fetch once, publish `aircraft` (array of blips) + `status`, and stop.

sub init()
    m.top.functionName = "run"
end sub

sub run()
    obs = m.top.observer
    if obs = invalid or obs.lat = invalid or obs.lon = invalid
        m.top.status = "Waiting for location…"
        return
    end if

    rngNm = m.top.rangeNm
    if rngNm = invalid or rngNm <= 0 then rngNm = 160
    if rngNm > 250 then rngNm = 250   ' adsb.lol per-query cap

    url = "https://api.adsb.lol/v2/lat/" + fmtF(obs.lat, 4) + "/lon/" + fmtF(obs.lon, 4) + "/dist/" + fmtF(rngNm, 0)

    ut = CreateObject("roUrlTransfer")
    ut.SetCertificatesFile("common:/certs/ca-bundle.crt")
    ut.InitClientCertificates()
    ut.SetMinimumTransferRate(1, 20)
    ut.AddHeader("User-Agent", "LivelySkyRadar/1.0")
    ut.SetUrl(url)

    resp = ut.GetToString()
    if resp = invalid or resp = ""
        m.top.status = "No data — offline?"
        m.top.aircraft = []
        return
    end if

    data = ParseJson(resp)
    if data = invalid or data.ac = invalid
        m.top.status = "No data"
        m.top.aircraft = []
        return
    end if

    blips = []
    for each a in data.ac
        if a.lat <> invalid and a.lon <> invalid
            altFt = pickAlt(a)
            if altFt <> invalid
                altM = altFt * 0.3048
                look = LS_LookAngles(obs.lat, obs.lon, 0.0, a.lat, a.lon, altM)
                if look.alt >= 1.0           ' above the horizon only
                    blips.Push({
                        az: look.az,
                        alt: look.alt,
                        rangeKm: look.range / 1000.0,
                        callsign: cleanStr(a.flight),
                        altFt: altFt,
                        gs: numOr(a.gs, 0),
                        track: numOr(a.track, 0),
                        hex: cleanStr(a.hex),
                        typ: cleanStr(a.t),
                        reg: cleanStr(a.r),
                        category: cleanStr(a.category),
                        mil: isMil(a)
                    })
                end if
            end if
        end if
    end for

    blips = sortByRange(blips)
    if blips.Count() > 60 then blips = sliceArr(blips, 0, 60)

    m.top.aircraft = blips
    if blips.Count() = 1
        m.top.status = "1 aircraft overhead"
    else
        m.top.status = Stri(blips.Count()).Trim() + " aircraft overhead"
    end if
end sub

' --- helpers ---------------------------------------------------------------

function pickAlt(a as object) as dynamic
    ' prefer geometric altitude, fall back to barometric; skip on-ground / invalid
    v = a.alt_geom
    if v = invalid then v = a.alt_baro
    if v = invalid then return invalid
    if type(v) = "roString" or type(v) = "String" then return invalid  ' "ground"
    if v < 0 then return invalid
    return v
end function

function isMil(a as object) as boolean
    if a.dbFlags = invalid then return false
    flags = a.dbFlags
    if type(flags) = "roString" then return false
    return (flags AND 1) = 1
end function

function numOr(v as dynamic, dflt as float) as float
    if v = invalid then return dflt
    if type(v) = "roString" or type(v) = "String" then return dflt
    return v
end function

function cleanStr(v as dynamic) as string
    if v = invalid then return ""
    if type(v) = "roString" or type(v) = "String" then return v.Trim()
    return Str(v).Trim()   ' numeric -> string
end function

' float -> compact string with N decimals, no leading space
function fmtF(x as float, decimals as integer) as string
    neg = x < 0
    if neg then x = -x
    scale = 1
    for i = 1 to decimals : scale = scale * 10 : end for
    n = Int(x * scale + 0.5)
    whole = Int(n / scale)
    frac = n - whole * scale
    s = Stri(whole).Trim()
    if decimals > 0
        fs = Stri(frac).Trim()
        while Len(fs) < decimals : fs = "0" + fs : end while
        s = s + "." + fs
    end if
    if neg then s = "-" + s
    return s
end function

function sortByRange(arr as object) as object
    ' simple insertion sort — arrays are small (<= a few hundred)
    for i = 1 to arr.Count() - 1
        key = arr[i]
        j = i - 1
        while j >= 0 and arr[j].rangeKm > key.rangeKm
            arr[j + 1] = arr[j]
            j = j - 1
        end while
        arr[j + 1] = key
    end for
    return arr
end function

function sliceArr(arr as object, startIdx as integer, count as integer) as object
    out = []
    last = startIdx + count - 1
    if last > arr.Count() - 1 then last = arr.Count() - 1
    for i = startIdx to last
        out.Push(arr[i])
    end for
    return out
end function
