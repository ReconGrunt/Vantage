' RadarScene.brs — interactive app shell: give the radar focus so the remote works.
sub init()
    m.top.backgroundColor = "0x00040Aff"
    m.top.backgroundURI = ""
    m.radar = m.top.findNode("radar")
    m.radar.setFocus(true)
end sub
