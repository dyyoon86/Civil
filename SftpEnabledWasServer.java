import com.jcraft.jsch.*;
import com.sun.net.httpserver.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class SftpEnabledWasServer {
    public static void main(String[] args) throws Exception {
        int port = 8080;
        File indexFile = new File("index.html").getAbsoluteFile();
        File devFile   = new File("/data/dev/out.txt");
        File tstFile   = new File("/data/tst/out.txt");
        File optFile   = new File("/data/opt/out.txt");
        File confFile  = null;
        // (생략: 전체 코드)
    }
}