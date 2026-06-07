' coords.brs — the geometry that keeps the radar honest.
'
' Sky convention (same as the LivelySky web app):
'   azimuth  deg, 0 = North, 90 = East, 180 = South, 270 = West (clockwise)
'   altitude deg, 0 = horizon, +90 = zenith
'
' Ported 1:1 from public/js/coords.js. BrightScript has no atan2/asin/acos, so we
' provide them here on top of the intrinsic Atn/Sqr/Sin/Cos.

function LS_DEG() as float : return 0.017453292519943295 : end function
function LS_RAD() as float : return 57.29577951308232 : end function
function LS_PI()  as float : return 3.141592653589793 : end function

function LS_Atan2(y as float, x as float) as float
    pi = LS_PI()
    if x > 0 then return Atn(y / x)
    if x < 0 then
        if y >= 0 then return Atn(y / x) + pi
        return Atn(y / x) - pi
    end if
    if y > 0 then return pi / 2.0
    if y < 0 then return -pi / 2.0
    return 0.0
end function

function LS_Asin(x as float) as float
    if x >= 1.0 then return LS_PI() / 2.0
    if x <= -1.0 then return -LS_PI() / 2.0
    return Atn(x / Sqr(1.0 - x * x))
end function

function LS_Acos(x as float) as float
    return LS_PI() / 2.0 - LS_Asin(x)
end function

' Geodetic (lat,lon deg; h metres) -> ECEF (m) on the WGS84 ellipsoid.
function LS_GeodeticToEcef(latDeg as float, lonDeg as float, h as float) as object
    deg = LS_DEG()
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = f * (2.0 - f)
    lat = latDeg * deg : lon = lonDeg * deg
    sinLat = Sin(lat) : cosLat = Cos(lat)
    n = a / Sqr(1.0 - e2 * sinLat * sinLat)
    return {
        x: (n + h) * cosLat * Cos(lon),
        y: (n + h) * cosLat * Sin(lon),
        z: (n * (1.0 - e2) + h) * sinLat
    }
end function

' Azimuth/altitude (deg) + range (m) of a target as seen from the observer.
' Accounts for Earth curvature via ECEF -> local ENU.
function LS_LookAngles(obsLat as float, obsLon as float, obsAlt as float, tLat as float, tLon as float, tAlt as float) as object
    deg = LS_DEG() : rad = LS_RAD()
    o = LS_GeodeticToEcef(obsLat, obsLon, obsAlt)
    t = LS_GeodeticToEcef(tLat, tLon, tAlt)
    dx = t.x - o.x : dy = t.y - o.y : dz = t.z - o.z

    lat = obsLat * deg : lon = obsLon * deg
    sinLat = Sin(lat) : cosLat = Cos(lat)
    sinLon = Sin(lon) : cosLon = Cos(lon)

    e = -sinLon * dx + cosLon * dy
    n = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz
    u = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz

    rng = Sqr(dx * dx + dy * dy + dz * dz)
    az = LS_Atan2(e, n) * rad
    if az < 0 then az = az + 360.0
    alt = LS_Asin(u / rng) * rad
    return { az: az, alt: alt, range: rng }
end function

' Great-circle distance (km) between two geodetic points (haversine).
function LS_HaversineKm(lat1 as float, lon1 as float, lat2 as float, lon2 as float) as float
    deg = LS_DEG()
    dLat = (lat2 - lat1) * deg
    dLon = (lon2 - lon1) * deg
    a = Sin(dLat / 2.0) * Sin(dLat / 2.0) + Cos(lat1 * deg) * Cos(lat2 * deg) * Sin(dLon / 2.0) * Sin(dLon / 2.0)
    return 6371.0 * 2.0 * LS_Atan2(Sqr(a), Sqr(1.0 - a))
end function

' Polar radar position for an az/alt within a disc of pixel radius R centred at
' (cx,cy). Zenith (alt 90) -> centre, horizon (alt 0) -> rim. 0 az points up (N).
function LS_RadarXY(az as float, alt as float, cx as float, cy as float, r as float) as object
    deg = LS_DEG()
    rr = (1.0 - alt / 90.0) * r
    if rr < 0 then rr = 0
    az_r = az * deg
    return { x: cx + rr * Sin(az_r), y: cy - rr * Cos(az_r) }
end function
