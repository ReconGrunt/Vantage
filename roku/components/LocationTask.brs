' LocationTask.brs — figure out where the viewer is.
' Roku TVs have no GPS, so: (1) use a saved override from the registry if the user
' set one, else (2) geolocate by public IP (free, no key), else (3) default.

sub init()
    m.top.functionName = "run"
end sub

sub run()
    saved = readSavedObserver()
    if saved <> invalid then
        m.top.location = saved
        return
    end if

    loc = fetchIpLocation()
    if loc <> invalid then
        m.top.location = loc
    else
        m.top.location = { lat: 40.7128, lon: -74.0060, label: "New York (default)" }
    end if
end sub

function readSavedObserver() as object
    sec = CreateObject("roRegistrySection", "LivelySky")
    if sec.Exists("observer")
        j = ParseJson(sec.Read("observer"))
        if j <> invalid and j.lat <> invalid and j.lon <> invalid
            if j.label = invalid then j.label = "Saved location"
            return j
        end if
    end if
    return invalid
end function

function fetchIpLocation() as object
    ut = CreateObject("roUrlTransfer")
    ut.SetCertificatesFile("common:/certs/ca-bundle.crt")
    ut.InitClientCertificates()
    ut.SetMinimumTransferRate(1, 20)   ' abort a stalled request (cert: degrade gracefully)
    ut.AddHeader("User-Agent", "LivelySkyRadar/1.0")
    ut.SetUrl("https://ipapi.co/json/")

    resp = ut.GetToString()
    if resp = invalid or resp = "" then return invalid
    d = ParseJson(resp)
    if d = invalid or d.latitude = invalid or d.longitude = invalid then return invalid

    label = ""
    if d.city <> invalid and d.city <> "" then label = d.city
    if d.region <> invalid and d.region <> ""
        if label <> "" then label = label + ", "
        label = label + d.region
    end if
    if label = "" then label = "Your location"
    return { lat: d.latitude, lon: d.longitude, label: label }
end function
