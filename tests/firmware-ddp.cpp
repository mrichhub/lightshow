#include "../firmware/esp32/include/ddp.hpp"
#include <array>
#include <cassert>
#include <iostream>
int main(){
 std::array<uint8_t,6> pixels{};lightshow::DdpAssembler receiver(pixels.data(),pixels.size());
 uint8_t first[]={0x40,1,0x0b,1,0,0,0,0,0,3,1,2,3};
 uint8_t last[]={0x41,2,0x0b,1,0,0,0,3,0,3,4,5,6};
 assert(!receiver.accept(first,sizeof(first),1,false,1));assert(!receiver.seen());
 assert(!receiver.accept(first,sizeof(first),1,true,10));assert(!receiver.accept(last,sizeof(last),2,true,11));
 assert(receiver.accept(last,sizeof(last),1,true,12));assert(receiver.frames==1);assert(pixels[5]==6);
 assert(!receiver.expired(5011));assert(receiver.expired(5012));
 assert(!receiver.accept(first,sizeof(first),2,true,5013));assert(receiver.accept(last,sizeof(last),2,true,5014));
 assert(!receiver.accept(last,sizeof(last),2,true,5015));assert(receiver.frames==2);
 first[1]=15;last[1]=1;assert(!receiver.accept(first,sizeof(first),2,true,5020));assert(receiver.accept(last,sizeof(last),2,true,5021));
 first[8]=255;assert(!receiver.accept(first,sizeof(first),2,true,5022));
 std::cout<<"Firmware DDP allowlist, source lock, sequence wrap, atomic completion, bounds and timeout passed\n";
}
