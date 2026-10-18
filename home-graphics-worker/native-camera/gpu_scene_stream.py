"""NVDEC input adapter for PySceneDetect. Detection itself remains unchanged."""
import subprocess
import numpy as np
from scenedetect import FrameTimecode, open_video

class GpuSceneStream:
    def __init__(self,path,ffmpeg):
        self.meta=open_video(str(path));self.count=0;self.finished=False
        width,height=self.meta.frame_size
        self.shape=(height,width,3);self.bytes=width*height*3
        self.process=subprocess.Popen([ffmpeg,'-v','error','-nostdin','-threads','1',
            '-hwaccel','cuda','-hwaccel_output_format','cuda','-i',str(path),
            '-map','0:v:0','-an','-vf','hwdownload,format=nv12,format=bgr24',
            '-fps_mode','passthrough','-f','rawvideo','pipe:1'],
            stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    def __getattr__(self,name):return getattr(self.meta,name)
    @property
    def frame_number(self):return self.count
    @property
    def position(self):return FrameTimecode(max(0,self.count-1),self.frame_rate)
    @property
    def position_ms(self):return self.position.get_seconds()*1000
    def read(self,decode=True):
        data=self.process.stdout.read(self.bytes)
        if len(data)!=self.bytes:
            if data or self.process.wait(timeout=10)!=0:raise RuntimeError('NVDEC decode failed')
            if self.count!=self.meta.duration.get_frames():raise RuntimeError('NVDEC frame count mismatch')
            self.finished=True;return False
        self.count+=1
        return np.frombuffer(data,dtype=np.uint8).reshape(self.shape) if decode else True
    def seek(self,target):raise RuntimeError('GPU scene seek unsupported')
    def close(self):
        if self.process.poll() is None:self.process.kill()
        self.process.wait(timeout=10)
        self.process.stdout.close()
        if hasattr(self.meta,'_cap'):self.meta._cap.release()
