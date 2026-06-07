' astro.brs — minimal local star + Sun positions (no network, no key).
' Depends on coords.brs (LS_DEG/RAD, LS_Asin/Acos/Atan2).

' Floating-point wrap into [0,360). BrightScript's MOD is integer-only (it would
' truncate away the fractional degrees), so we do it with Int()/subtraction.
function LS_Wrap360(x as double) as double
    y = x - Int(x / 360.0) * 360.0   ' Int() truncates toward zero
    if y < 0 then y = y + 360.0
    return y
end function

' Julian Date from a Unix epoch (seconds, UTC).
function LS_JulianDate(unixSec as double) as double
    return unixSec / 86400.0 + 2440587.5
end function

' Greenwich Mean Sidereal Time (deg) for a Julian Date.
function LS_GmstDeg(jd as double) as double
    d = jd - 2451545.0
    return LS_Wrap360(280.46061837 + 360.98564736629 * d)
end function

' Star alt/az (deg) from RA/Dec (deg), observer lat/lon (deg) and Unix time.
' Standard hour-angle transform; azimuth measured from North, clockwise.
function LS_StarAltAz(raDeg as float, decDeg as float, latDeg as float, lonDeg as float, unixSec as double) as object
    deg = LS_DEG() : rad = LS_RAD()
    jd = LS_JulianDate(unixSec)
    lst = LS_GmstDeg(jd) + lonDeg          ' local sidereal time, deg
    h = LS_Wrap360(lst - raDeg)            ' hour angle, deg

    hr = h * deg : dec = decDeg * deg : lat = latDeg * deg
    sinAlt = Sin(dec) * Sin(lat) + Cos(dec) * Cos(lat) * Cos(hr)
    alt = LS_Asin(sinAlt)

    cosAlt = Cos(alt)
    az = 0.0
    if cosAlt > 0.0001 then
        cosAz = (Sin(dec) - Sin(lat) * sinAlt) / (Cos(lat) * cosAlt)
        if cosAz > 1.0 then cosAz = 1.0
        if cosAz < -1.0 then cosAz = -1.0
        az = LS_Acos(cosAz) * rad
        if Sin(hr) > 0.0 then az = 360.0 - az
    end if
    return { az: az, alt: alt * rad }
end function

' Approximate Sun alt/az (deg) — low-precision ephemeris, good to ~0.1 deg, plenty
' for placing a disc on the radar / driving day-night ambiance.
function LS_SunAltAz(latDeg as float, lonDeg as float, unixSec as double) as object
    deg = LS_DEG()
    jd = LS_JulianDate(unixSec)
    d = jd - 2451545.0
    g = LS_Wrap360(357.529 + 0.98560028 * d)      ' mean anomaly
    q = LS_Wrap360(280.459 + 0.98564736 * d)      ' mean longitude
    lng = q + 1.915 * Sin(g * deg) + 0.020 * Sin(2.0 * g * deg)
    e = 23.439 - 0.00000036 * d                   ' obliquity
    ra = LS_RAD() * LS_Atan2(Cos(e * deg) * Sin(lng * deg), Cos(lng * deg))
    if ra < 0 then ra = ra + 360.0
    dec = LS_RAD() * LS_Asin(Sin(e * deg) * Sin(lng * deg))
    return LS_StarAltAz(ra, dec, latDeg, lonDeg, unixSec)
end function
