using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Byte drains never pass a native error stream through PowerShell's CLIXML parser.
public static class KcoderOwnedNativeStreams {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  public sealed class Capture {
    public int ProcessId, ExitCode;
    public string CreationTicks;
    public bool InheritedJob, TimedOut, OutputLimitExceeded, DrainsCompleted;
    public long StdoutBytes, StderrBytes;
  }
  public static bool InheritedJob(IntPtr process) { bool result; if(!IsProcessInJob(process,IntPtr.Zero,out result))throw new System.ComponentModel.Win32Exception();return result; }
  sealed class Drain { public long Bytes; public int Overflow; }
  static string Quote(string value) {
    var text=new StringBuilder("\"");int slashes=0;
    foreach(char c in value) {
      if(c=='\\'){slashes++;continue;}
      if(c=='\"'){text.Append('\\',slashes*2+1);text.Append(c);slashes=0;continue;}
      text.Append('\\',slashes);slashes=0;text.Append(c);
    }
    text.Append('\\',slashes*2);return text.Append('\"').ToString();
  }
  static Task Pump(Stream input, Stream output, int limit, Drain state) {
    return Task.Run(async () => {
      var buffer=new byte[8192];int count;
      while((count=await input.ReadAsync(buffer,0,buffer.Length))!=0) {
        long before=state.Bytes;state.Bytes+=count;
        int keep=(int)Math.Max(0,Math.Min((long)count,limit-before));
        if(keep>0)await output.WriteAsync(buffer,0,keep);
        if(state.Bytes>limit)Interlocked.Exchange(ref state.Overflow,1);
      }
      await output.FlushAsync();
    });
  }
  public static Capture Run(string executable,string[] arguments,string cwd,string stdout,string stderr,int timeoutMs,int limit) {
    if(timeoutMs<=0||limit<=0)throw new ArgumentOutOfRangeException();
    var start=new ProcessStartInfo(executable) {WorkingDirectory=cwd,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
    start.Arguments=String.Join(" ",Array.ConvertAll(arguments,Quote));
    var receipt=new Capture();var outState=new Drain();var errState=new Drain();
    using(var outFile=new FileStream(stdout,FileMode.CreateNew,FileAccess.Write,FileShare.Read))
    using(var errFile=new FileStream(stderr,FileMode.CreateNew,FileAccess.Write,FileShare.Read))
    using(var process=new Process {StartInfo=start}) {
      Task output=null,error=null;
      try {
        if(!process.Start())throw new InvalidOperationException("Owned native child did not start");
        receipt.ProcessId=process.Id;receipt.CreationTicks=process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
        bool inJob;if(!IsProcessInJob(process.Handle,IntPtr.Zero,out inJob)||!inJob)throw new InvalidOperationException("Owned native child escaped inherited Job");
        receipt.InheritedJob=inJob;
        output=Pump(process.StandardOutput.BaseStream,outFile,limit,outState);
        error=Pump(process.StandardError.BaseStream,errFile,limit,errState);
        var clock=Stopwatch.StartNew();
        while(!process.WaitForExit(50)) {
          if(clock.ElapsedMilliseconds>=timeoutMs){receipt.TimedOut=true;process.Kill();break;}
          if(Volatile.Read(ref outState.Overflow)!=0||Volatile.Read(ref errState.Overflow)!=0){process.Kill();break;}
        }
        if(!process.WaitForExit(1000))throw new InvalidOperationException("Owned native child exit unconfirmed");
        receipt.ExitCode=process.ExitCode;
        try {receipt.DrainsCompleted=Task.WaitAll(new[]{output,error},1000);}catch(AggregateException){receipt.DrainsCompleted=false;}
        receipt.StdoutBytes=outState.Bytes;receipt.StderrBytes=errState.Bytes;
        receipt.OutputLimitExceeded=outState.Overflow!=0||errState.Overflow!=0;
        return receipt;
      } finally {
        if(receipt.ProcessId!=0&&!process.HasExited){process.Kill();if(!process.WaitForExit(1000))throw new InvalidOperationException("Owned native cancellation exit unconfirmed");}
        // Closing pipes also releases drains if a descendant retained a pipe.
        if(receipt.ProcessId!=0){process.StandardOutput.Close();process.StandardError.Close();}
        foreach(var task in new[]{output,error})if(task!=null)task.ContinueWith(t=>{GC.KeepAlive(t.Exception);},TaskContinuationOptions.OnlyOnFaulted);
      }
    }
  }
}
