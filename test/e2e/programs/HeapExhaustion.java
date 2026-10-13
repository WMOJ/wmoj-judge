// The Java twin of refuse-allocation.cpp. A JVM's limit is enforced by
// -Xmx rather than by RLIMIT_AS, so what a Java program sees at the limit
// is OutOfMemoryError: 600 MB of live arrays against a 256 MB limit.
import java.util.ArrayList;
import java.util.List;

public class Main {
    public static void main(String[] args) {
        List<long[]> held = new ArrayList<>();
        for (int i = 0; i < 600; i++) {
            held.add(new long[1 << 17]);
        }
        System.out.println(held.size());
    }
}
