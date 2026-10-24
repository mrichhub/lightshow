#pragma once
#include <cstdint>
#include <cstddef>
#include <cstring>

namespace lightshow {
// Portable parser shared by firmware and native regression tests. Full ordered RGB frames only.
class DdpAssembler {
  uint8_t* pixels_; size_t size_, expected_=0; uint8_t sequence_=0;
  bool assembling_=false, hasSource_=false, seen_=false; uint32_t source_=0,last_=0;
public:
  uint32_t dropped=0,incomplete=0,frames=0,timeoutMs=5000;
  DdpAssembler(uint8_t* pixels,size_t size):pixels_(pixels),size_(size){}
  void buffer(uint8_t* pixels){pixels_=pixels;}
  void configure(size_t size,uint32_t timeout){size_=size;timeoutMs=timeout;reset();seen_=false;hasSource_=false;}
  void reset(){expected_=0;sequence_=0;assembling_=false;}
  bool seen() const{return seen_;}
  uint32_t age(uint32_t now) const{return seen_?now-last_:UINT32_MAX;}
  bool expired(uint32_t now) const{return !seen_||uint32_t(now-last_)>=timeoutMs;}
  bool accept(const uint8_t* p,size_t n,uint32_t source,bool allowed,uint32_t now){
    if(!allowed||n<10||(p[0]!=0x40&&p[0]!=0x41)||p[1]>15||p[2]!=0x0b||p[3]!=1){dropped++;return false;}
    const uint32_t offset=(uint32_t(p[4])<<24)|(uint32_t(p[5])<<16)|(uint32_t(p[6])<<8)|p[7];
    const size_t length=(size_t(p[8])<<8)|p[9];
    if(length!=n-10||length%3||offset%3||offset>size_||length>size_-offset){dropped++;return false;}
    if(hasSource_&&source!=source_&&!expired(now)){dropped++;return false;}
    if(!hasSource_||source!=source_){reset();source_=source;hasSource_=true;}
    last_=now;seen_=true;
    if(offset==0&&length){if(assembling_)incomplete++;reset();assembling_=true;}
    if(!assembling_||offset!=expected_||(sequence_&&p[1]&&p[1]!=sequence_%15+1)){dropped++;if(assembling_)incomplete++;reset();return false;}
    std::memcpy(pixels_+offset,p+10,length);expected_+=length;sequence_=p[1];
    if(p[0]&1){if(expected_==size_){frames++;reset();return true;}incomplete++;reset();}
    return false;
  }
};
}
