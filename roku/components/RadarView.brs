' RadarView.brs — draws the live radar: range rings (baked in radar_bg.png), a
' rotating sweep, live aircraft blips, tonight's bright stars and the Sun, plus a
' HUD. Interactive mode adds remote control (range + plane selection).

sub init()
    m.cx = 960 : m.cy = 540 : m.R = 470

    m.grid       = m.top.findNode("grid")
    m.starLayer  = m.top.findNode("starLayer")
    m.sunLayer   = m.top.findNode("sunLayer")
    m.blipLayer  = m.top.findNode("blipLayer")
    m.selRing    = m.top.findNode("selRing")
    m.statusLbl  = m.top.findNode("status")
    m.locLbl     = m.top.findNode("loclabel")
    m.clockLbl   = m.top.findNode("clock")
    m.hintLbl    = m.top.findNode("hint")
    m.infoPanel  = m.top.findNode("infoPanel")
    m.infoText   = m.top.findNode("infoText")
    m.locTask    = m.top.findNode("locTask")
    m.acTask     = m.top.findNode("acTask")
    m.pollTimer  = m.top.findNode("pollTimer")
    m.clockTimer = m.top.findNode("clockTimer")
    m.sweepAnim  = m.top.findNode("sweepAnim")

    m.observer = invalid
    m.rangeNm  = 160
    m.blips    = []
    m.selIndex = -1
    m.starTick = 999

    m.stars = loadStars()

    m.locTask.observeField("location", "onLocation")
    m.acTask.observeField("aircraft", "onAircraft")
    m.acTask.observeField("status", "onStatus")
    m.pollTimer.observeField("fire", "onPoll")
    m.clockTimer.observeField("fire", "onTick")

    if m.top.interactive
        m.hintLbl.text = "Up/Down: range    Left/Right: select plane    OK: info"
    end if

    m.sweepAnim.control = "start"
    m.clockTimer.control = "start"
    updateClock()

    ' kick off location -> everything else flows from onLocation()
    m.locTask.control = "RUN"
end sub

' --- data flow -------------------------------------------------------------

sub onLocation()
    loc = m.locTask.location
    if loc = invalid then return
    m.observer = loc
    m.locLbl.text = loc.label + "   (" + fmt2(loc.lat) + ", " + fmt2(loc.lon) + ")"
    renderStars()
    renderSun()
    triggerFetch()
    m.pollTimer.control = "start"
end sub

sub triggerFetch()
    if m.observer = invalid then return
    m.acTask.observer = m.observer
    m.acTask.rangeNm = m.rangeNm
    m.acTask.control = "RUN"
end sub

sub onPoll()
    triggerFetch()
    m.starTick = m.starTick + 1
    if m.starTick >= 6          ' refresh the slow-moving sky ~every 30s
        renderStars()
        renderSun()
        m.starTick = 0
    end if
end sub

sub onTick()
    updateClock()
end sub

sub onStatus()
    m.statusLbl.text = m.acTask.status
    m.top.status = m.acTask.status
end sub

sub onAircraft()
    ac = m.acTask.aircraft
    if ac = invalid then ac = []
    m.blips = ac
    if m.selIndex >= m.blips.Count() then m.selIndex = m.blips.Count() - 1
    renderBlips()
    refreshSelection()
end sub

' --- rendering -------------------------------------------------------------

sub renderBlips()
    clearLayer(m.blipLayer)
    for i = 0 to m.blips.Count() - 1
        b = m.blips[i]
        p = LS_RadarXY(b.az, b.alt, m.cx, m.cy, m.R)
        dot = CreateObject("roSGNode", "Poster")
        dot.uri = "pkg:/images/dot.png"
        dot.width = 26 : dot.height = 26
        dot.blendColor = blipColor(b)
        dot.translation = [p.x - 13, p.y - 13]
        m.blipLayer.appendChild(dot)

        ' label the nearest handful in the app (kept clutter-free in screensaver)
        if m.top.interactive and i < 16 and b.callsign <> ""
            lbl = CreateObject("roSGNode", "Label")
            lbl.text = b.callsign
            lbl.color = "0xcfe0f0ff"
            lbl.translation = [p.x + 15, p.y - 12]
            m.blipLayer.appendChild(lbl)
        end if
    end for
end sub

sub renderStars()
    if m.observer = invalid then return
    clearLayer(m.starLayer)
    nowS# = nowUnix()
    for each s in m.stars
        aa = LS_StarAltAz(s.ra, s.dec, m.observer.lat, m.observer.lon, nowS#)
        if aa.alt > 2.0
            p = LS_RadarXY(aa.az, aa.alt, m.cx, m.cy, m.R)
            sz = 9
            if s.mag < 1.0 then
                sz = 16
            else if s.mag < 1.8 then
                sz = 12
            end if
            d = CreateObject("roSGNode", "Poster")
            d.uri = "pkg:/images/star.png"
            d.width = sz : d.height = sz
            d.opacity = 0.8
            d.translation = [p.x - sz / 2, p.y - sz / 2]
            m.starLayer.appendChild(d)
        end if
    end for
end sub

sub renderSun()
    if m.observer = invalid then return
    clearLayer(m.sunLayer)
    sun = LS_SunAltAz(m.observer.lat, m.observer.lon, nowUnix())
    if sun.alt > 0.0
        p = LS_RadarXY(sun.az, sun.alt, m.cx, m.cy, m.R)
        sz = 64
        d = CreateObject("roSGNode", "Poster")
        d.uri = "pkg:/images/dot.png"
        d.width = sz : d.height = sz
        d.blendColor = "0xffd23cff"
        d.opacity = 0.95
        d.translation = [p.x - sz / 2, p.y - sz / 2]
        m.sunLayer.appendChild(d)
    end if
end sub

' --- interaction -----------------------------------------------------------

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if not m.top.interactive then return false

    if key = "up"
        m.rangeNm = clampRange(m.rangeNm + 20) : triggerFetch() : return true
    else if key = "down"
        m.rangeNm = clampRange(m.rangeNm - 20) : triggerFetch() : return true
    else if key = "left"
        cycleSel(-1) : return true
    else if key = "right"
        cycleSel(1) : return true
    else if key = "OK"
        m.infoPanel.visible = not m.infoPanel.visible : return true
    end if
    return false
end function

sub cycleSel(d as integer)
    if m.blips.Count() = 0
        m.selIndex = -1
        refreshSelection()
        return
    end if
    if m.selIndex < 0
        m.selIndex = 0
    else
        m.selIndex = (m.selIndex + d + m.blips.Count()) MOD m.blips.Count()
    end if
    m.infoPanel.visible = true
    refreshSelection()
end sub

sub refreshSelection()
    if m.selIndex < 0 or m.selIndex >= m.blips.Count()
        m.selRing.visible = false
        m.infoPanel.visible = false
        return
    end if
    b = m.blips[m.selIndex]
    p = LS_RadarXY(b.az, b.alt, m.cx, m.cy, m.R)
    m.selRing.translation = [p.x - 28, p.y - 28]
    m.selRing.visible = true
    m.infoText.text = infoTextFor(b)
end sub

function infoTextFor(b as object) as string
    cs = b.callsign : if cs = "" then cs = "(no callsign)"
    t = cs + Chr(10)
    if b.typ <> "" then t = t + "Type: " + b.typ + Chr(10)
    if b.reg <> "" then t = t + "Reg: " + b.reg + Chr(10)
    t = t + "Altitude: " + commas(Int(b.altFt)) + " ft" + Chr(10)
    t = t + "Speed: " + Stri(Int(b.gs)).Trim() + " kt" + Chr(10)
    t = t + "Heading: " + Stri(Int(b.track)).Trim() + Chr(176) + Chr(10)
    t = t + "Distance: " + fmt1(b.rangeKm) + " km" + Chr(10)
    t = t + "Bearing: " + Stri(Int(b.az)).Trim() + Chr(176) + "   Elev: " + fmt1(b.alt) + Chr(176)
    if b.mil then t = t + Chr(10) + "** Military **"
    return t
end function

' --- helpers ---------------------------------------------------------------

function blipColor(b as object) as string
    if b.mil then return "0xff5a5aff"
    if b.altFt < 10000 then return "0x6fdc8cff"   ' low — green
    if b.altFt < 25000 then return "0xffc233ff"   ' mid — amber
    return "0x7fd8ffff"                            ' high — cyan
end function

function clampRange(v as float) as float
    if v < 40 then return 40
    if v > 250 then return 250
    return v
end function

sub clearLayer(layer as object)
    while layer.getChildCount() > 0
        layer.removeChildIndex(0)
    end while
end sub

function loadStars() as object
    raw = ReadAsciiFile("pkg:/data/stars_bright.json")
    if raw = "" then return []
    j = ParseJson(raw)
    if j = invalid then return []
    return j
end function

function nowUnix() as double
    dt = CreateObject("roDateTime")
    return dt.AsSeconds()
end function

sub updateClock()
    dt = CreateObject("roDateTime")
    hh = dt.GetHours()
    mm = dt.GetMinutes()
    m.clockLbl.text = pad2(hh) + ":" + pad2(mm) + " UTC"
end sub

function pad2(n as integer) as string
    s = Stri(n).Trim()
    if Len(s) < 2 then s = "0" + s
    return s
end function

function fmt1(x as float) as string
    return fmtDec(x, 1)
end function

function fmt2(x as float) as string
    return fmtDec(x, 2)
end function

function fmtDec(x as float, decimals as integer) as string
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

function commas(n as integer) as string
    s = Stri(n).Trim()
    out = ""
    c = 0
    for i = Len(s) - 1 to 0 step -1
        out = Mid(s, i + 1, 1) + out
        c = c + 1
        if c MOD 3 = 0 and i > 0 then out = "," + out
    end for
    return out
end function
